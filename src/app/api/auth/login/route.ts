/**
 * GET /api/auth/login → redirect to the Cognito Hosted UI.
 *
 * Sets a short-lived, httpOnly state cookie (CSRF defence) that /callback checks
 * against the returned `state`. There is no signup link — the pool is configured
 * admin-create-only, so the Hosted UI shows sign-in only.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { oauthEnv, authorizeUrl } from "@/lib/auth/oauth";
import { STATE_COOKIE, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const env = oauthEnv(req.nextUrl.origin);
  if (!env) {
    return NextResponse.json(
      { error: "Auth not configured (COGNITO_* env unset)." },
      { status: 500 }
    );
  }

  const state = randomUUID();
  const res = NextResponse.redirect(authorizeUrl(env, state));
  // 10 min is plenty to complete the Hosted-UI round trip.
  res.cookies.set(STATE_COOKIE, state, sessionCookieOptions(600));
  return res;
}
