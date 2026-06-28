/**
 * GET /api/auth/logout → clear the session cookie and sign out of Cognito.
 *
 * We clear the local cookie first, then redirect through the Hosted-UI /logout
 * so the Cognito session is killed too (otherwise the next /login would silently
 * re-auth the same user).
 */

import { NextRequest, NextResponse } from "next/server";
import { oauthEnv, logoutUrl } from "@/lib/auth/oauth";
import { SESSION_COOKIE, clearedCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = (process.env.DEPLOYMENT_URL || req.nextUrl.origin).replace(/\/$/, "");
  const env = oauthEnv(origin);

  const target = env ? logoutUrl(env, `${origin}/login`) : `${origin}/login`;
  const res = NextResponse.redirect(target);
  res.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
  return res;
}
