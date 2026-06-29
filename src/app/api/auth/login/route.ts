/**
 * GET /api/auth/login → redirect to the Cognito Hosted UI.
 *
 * Sets a short-lived, httpOnly state cookie (CSRF defence) that /callback checks
 * against the returned `state`. There is no signup link — the pool is configured
 * admin-create-only, so the Hosted UI shows sign-in only.
 *
 * Optional `?idp=<ProviderName>` jumps straight to a federated IdP (a customer's
 * Okta/Entra/etc., registered via deploy/cognito/add-idp.sh) instead of showing
 * the chooser — the direct-SSO-link path. Restricted to a safe name charset so it
 * can't smuggle extra authorize params; an unknown name just falls back to the
 * chooser at Cognito.
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

  // Cognito IdP names allow letters, digits, and _ . - (max 32); reject anything
  // else rather than forward it into the authorize URL.
  const rawIdp = req.nextUrl.searchParams.get("idp");
  const idp = rawIdp && /^[\w.-]{1,32}$/.test(rawIdp) ? rawIdp : undefined;

  const state = randomUUID();
  const res = NextResponse.redirect(authorizeUrl(env, state, idp));
  // 10 min is plenty to complete the Hosted-UI round trip.
  res.cookies.set(STATE_COOKIE, state, sessionCookieOptions(600));
  return res;
}
