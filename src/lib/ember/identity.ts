/**
 * Ember — request identity.
 *
 * Phase-1 multi-tenant auth. `middleware.ts` verifies the Cognito id-token (JWT)
 * once per request and stamps the verified claims onto forwarded headers; route
 * handlers read them back here. Routes NEVER trust a header they can set
 * themselves — middleware is the only writer and it strips any inbound copy
 * before forwarding (see stripIdentityHeaders), so a client cannot spoof these.
 *
 * `tenantId` is the company boundary (Cognito `custom:tenantId`); `userId` is the
 * Cognito `sub`. When auth is not configured (EMBER_AUTH_DISABLED=1, e.g. a
 * personal single-user deploy) both fall back to "default" — the same value the
 * pre-auth code hardcoded — so existing "default"-keyed data keeps resolving.
 */

import type { NextRequest } from "next/server";

export const USER_HEADER = "x-ember-user";
export const TENANT_HEADER = "x-ember-tenant";

/** The single-tenant fallback used when auth is disabled. Matches legacy rows. */
export const DEFAULT_TENANT_ID = "default";
export const DEFAULT_USER_ID = "default";

export interface Identity {
  userId: string;
  tenantId: string;
}

/** True when the deploy intentionally runs without auth (personal/dev mode). */
export function authDisabled(): boolean {
  return process.env.EMBER_AUTH_DISABLED === "1";
}

/**
 * Read the verified identity that middleware stamped onto the request. Throws if
 * auth is enabled but the headers are absent — that only happens if a route is
 * reached without passing middleware (a config bug), and failing closed is the
 * safe choice for a security boundary.
 */
export function getIdentity(req: NextRequest): Identity {
  const userId = req.headers.get(USER_HEADER);
  const tenantId = req.headers.get(TENANT_HEADER);

  if (userId && tenantId) return { userId, tenantId };

  if (authDisabled()) {
    return { userId: DEFAULT_USER_ID, tenantId: DEFAULT_TENANT_ID };
  }

  throw new Error(
    "Missing verified identity headers. A route was reached without auth middleware."
  );
}
