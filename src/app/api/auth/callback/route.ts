/**
 * GET /api/auth/callback → Cognito redirects here with ?code & ?state.
 *
 * Verifies state (CSRF), exchanges the code for tokens, verifies the id-token,
 * then drops the session cookie and bounces to the app. We verify the token here
 * (not just trust the exchange) so a misissued token never reaches a cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { oauthEnv, exchangeCode } from "@/lib/auth/oauth";
import { verifyIdToken } from "@/lib/auth/cognito";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  sessionCookieOptions,
  clearedCookieOptions,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const env = oauthEnv(req.nextUrl.origin);
  if (!env) {
    return NextResponse.json({ error: "Auth not configured." }, { status: 500 });
  }

  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  const tokens = await exchangeCode(env, code);
  if (!tokens?.id_token) {
    return NextResponse.json({ error: "Token exchange failed." }, { status: 401 });
  }

  // Re-verify before trusting: signature, issuer, audience.
  const claims = await verifyIdToken(tokens.id_token, env);
  if (!claims) {
    return NextResponse.json({ error: "Token verification failed." }, { status: 401 });
  }

  const res = NextResponse.redirect(`${(process.env.DEPLOYMENT_URL || url.origin).replace(/\/$/, "")}/ember`);
  res.cookies.set(
    SESSION_COOKIE,
    tokens.id_token,
    sessionCookieOptions(Math.min(tokens.expires_in || 3600, 3600))
  );
  res.cookies.set(STATE_COOKIE, "", clearedCookieOptions());
  return res;
}
