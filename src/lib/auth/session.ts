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

/** Cognito id-tokens last 1h by default; cap the cookie to the same. */
export const SESSION_MAX_AGE_S = 60 * 60;

export function sessionCookieOptions(maxAgeS: number = SESSION_MAX_AGE_S) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeS,
  };
}

export function clearedCookieOptions() {
  return { ...sessionCookieOptions(0), maxAge: 0 };
}
