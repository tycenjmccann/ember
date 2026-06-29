/**
 * Ember auth gate (Phase 1 multi-tenant).
 *
 * Runs on every request except static assets and the auth endpoints. Verifies the
 * Cognito id-token from the session cookie and forwards the verified identity to
 * route handlers via x-ember-user / x-ember-tenant headers. Those headers are the
 * ONLY trusted identity source downstream; we strip any client-supplied copy
 * first so they cannot be spoofed.
 *
 *   unauthenticated + /api/* → 401 JSON
 *   unauthenticated + page   → 302 to /login
 *
 * Escape hatch: EMBER_AUTH_DISABLED=1 bypasses the gate entirely (personal /
 * single-user deploy). When set, downstream falls back to the "default" identity
 * exactly as the pre-auth code did.
 *
 * NOTE: jose verifies on the edge runtime; no Node built-ins here.
 */

import { NextRequest, NextResponse } from "next/server";
import { cognitoConfig, verifyIdToken, type VerifiedClaims } from "@/lib/auth/cognito";
import { oauthEnv, refreshTokens } from "@/lib/auth/oauth";
import {
  SESSION_COOKIE,
  REFRESH_COOKIE,
  SESSION_MAX_AGE_S,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { USER_HEADER, TENANT_HEADER } from "@/lib/ember/identity";

// Paths that must remain reachable without a session.
const PUBLIC_PREFIXES = ["/api/auth/", "/login", "/_next/", "/favicon", "/apple-touch-icon", "/ember-icon", "/manifest"];

function isPublic(pathname: string): boolean {
  if (pathname === "/login") return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function stripIdentityHeaders(req: NextRequest): Headers {
  const h = new Headers(req.headers);
  h.delete(USER_HEADER);
  h.delete(TENANT_HEADER);
  return h;
}

function unauthenticated(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  // Personal-deploy bypass: no auth wired, fall through with default identity.
  if (process.env.EMBER_AUTH_DISABLED === "1") {
    const headers = stripIdentityHeaders(req);
    headers.set(USER_HEADER, "default");
    headers.set(TENANT_HEADER, "default");
    return NextResponse.next({ request: { headers } });
  }

  const cfg = cognitoConfig();
  if (!cfg) {
    // Auth expected (not explicitly disabled) but unconfigured → fail closed.
    return NextResponse.json(
      { error: "Auth misconfigured: COGNITO_* env unset and EMBER_AUTH_DISABLED!=1." },
      { status: 500 }
    );
  }

  // Browser uses the httpOnly cookie; programmatic clients (the port-session MCP)
  // send the same Cognito JWT as a Bearer token. Both verify identically.
  const bearer = req.headers.get("authorization");
  const bearerToken = bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : null;
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value;
  const token = bearerToken || cookieToken;

  let claims: VerifiedClaims | null = token ? await verifyIdToken(token, cfg) : null;

  // id-token missing or expired → transparently re-mint it from the refresh token
  // so the browser session survives until the refresh token itself expires (10y).
  // Bearer (MCP) callers manage their own refresh, so only the cookie path here.
  let refreshedIdToken: string | null = null;
  if (!claims && !bearerToken) {
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
    const env = oauthEnv(req.nextUrl.origin);
    if (refresh && env) {
      const next = await refreshTokens(env, refresh);
      if (next?.id_token) {
        const verified = await verifyIdToken(next.id_token, cfg);
        if (verified) {
          claims = verified;
          refreshedIdToken = next.id_token;
        }
      }
    }
  }

  if (!claims) return unauthenticated(req);

  const headers = stripIdentityHeaders(req);
  headers.set(USER_HEADER, claims.userId);
  headers.set(TENANT_HEADER, claims.tenantId);
  const res = NextResponse.next({ request: { headers } });
  // Persist the freshly minted id-token so subsequent requests skip the refresh.
  if (refreshedIdToken) {
    res.cookies.set(SESSION_COOKIE, refreshedIdToken, sessionCookieOptions(SESSION_MAX_AGE_S));
  }
  return res;
}

export const config = {
  // Match everything; isPublic() handles the allowlist. (Static files are also
  // skipped by the negative lookahead for performance.)
  matcher: ["/((?!_next/static|_next/image).*)"],
};
