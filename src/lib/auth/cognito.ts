/**
 * Cognito OIDC config + JWT verification.
 *
 * Edge-safe (uses `jose`, no Node built-ins) so middleware.ts can call verify()
 * in the edge runtime. The JWKS is fetched once and cached by jose with its own
 * rotation handling.
 *
 * All values come from env (set by deploy/cognito + App Runner). Nothing is baked
 * in — this repo is open source and each deployer wires their own pool.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  // The public CLI client (port-session `authenticate`). Its id-tokens carry
  // aud=COGNITO_CLI_CLIENT_ID, so the verifier must trust it alongside the web
  // client. Unset on deploys without the CLI client → only the web aud is valid.
  cliClientId?: string;
  domain: string; // e.g. https://ember-xxxx.auth.us-east-1.amazoncognito.com
}

export function cognitoConfig(): CognitoConfig | null {
  const region = process.env.AWS_REGION || "us-east-1";
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const cliClientId = process.env.COGNITO_CLI_CLIENT_ID || undefined;
  const domain = process.env.COGNITO_DOMAIN;
  if (!userPoolId || !clientId || !domain) return null;
  return { region, userPoolId, clientId, cliClientId, domain: domain.replace(/\/$/, "") };
}

export function issuerUrl(cfg: CognitoConfig): string {
  return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
}

// jose caches keys + handles rotation; keep one JWKS per issuer across requests.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks(cfg: CognitoConfig) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(`${issuerUrl(cfg)}/.well-known/jwks.json`));
  }
  return _jwks;
}

export interface VerifiedClaims {
  userId: string; // Cognito sub
  tenantId: string; // custom:tenantId (falls back to "default" if unset)
  email?: string;
  groups: string[]; // cognito:groups — used for the admin gate
}

/**
 * Verify a Cognito id-token and extract the claims Ember cares about. Validates
 * signature, issuer, and audience. Both the web client and the public CLI client
 * (used by port-session `authenticate`) are trusted audiences, since both mint
 * id-tokens for the same pool. Returns null on any failure — callers treat that
 * as unauthenticated.
 */
export async function verifyIdToken(
  token: string,
  cfg: CognitoConfig
): Promise<VerifiedClaims | null> {
  try {
    const audience = cfg.cliClientId ? [cfg.clientId, cfg.cliClientId] : cfg.clientId;
    const { payload } = await jwtVerify(token, jwks(cfg), {
      issuer: issuerUrl(cfg),
      audience,
    });
    return claimsFrom(payload);
  } catch {
    return null;
  }
}

function claimsFrom(p: JWTPayload): VerifiedClaims | null {
  const sub = typeof p.sub === "string" ? p.sub : null;
  if (!sub) return null;
  const groups = Array.isArray(p["cognito:groups"])
    ? (p["cognito:groups"] as string[])
    : [];
  return {
    userId: sub,
    tenantId: (p["custom:tenantId"] as string) || "default",
    email: typeof p.email === "string" ? p.email : undefined,
    groups,
  };
}
