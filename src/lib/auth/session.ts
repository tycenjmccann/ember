/**
 * Auth session cookie.
 *
 * We store the Cognito id-token in an httpOnly, Secure, SameSite=Lax cookie. Lax
 * (not Strict) so the cookie rides along on the top-level redirect back from the
 * Cognito Hosted UI. The token is a signed JWT — middleware re-verifies it on
 * every request, so a stolen-but-expired token is useless and we never trust the
 * cookie's contents without verification.
 */

export const SESSION_COOKIE = "ember_id_token";
export const STATE_COOKIE = "ember_oauth_state";
// The long-lived refresh token. Middleware uses it to silently mint a fresh
// id-token when the short one expires, so the user is never logged out until the
// refresh token itself expires (Cognito max 10y, set on the app client).
export const REFRESH_COOKIE = "ember_refresh_token";

/** id-token cookie lifetime — matches the id-token validity on the app client. */
export const SESSION_MAX_AGE_S = 24 * 60 * 60;
/** Refresh-token cookie lifetime — the cap on "stay logged in" (10y). */
export const REFRESH_MAX_AGE_S = 3650 * 24 * 60 * 60;

export function sessionCookieOptions(maxAgeS: number = SESSION_MAX_AGE_S) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeS,
  };
}

export function refreshCookieOptions(maxAgeS: number = REFRESH_MAX_AGE_S) {
  return sessionCookieOptions(maxAgeS);
}

export function clearedCookieOptions() {
  return { ...sessionCookieOptions(0), maxAge: 0 };
}
