/**
 * Cognito Hosted-UI OAuth2 (authorization-code) helpers, server-side.
 *
 * We use the code flow with a confidential client: the browser only ever holds
 * the httpOnly session cookie, never the token directly. The client secret stays
 * on the server (App Runner instance env).
 */

import { cognitoConfig, type CognitoConfig } from "./cognito";

export interface OAuthEnv extends CognitoConfig {
  clientSecret?: string; // confidential client
  redirectUri: string; // <DEPLOYMENT_URL>/api/auth/callback
}

export function oauthEnv(origin: string): OAuthEnv | null {
  const cfg = cognitoConfig();
  if (!cfg) return null;
  const base = (process.env.DEPLOYMENT_URL || origin).replace(/\/$/, "");
  return {
    ...cfg,
    clientSecret: process.env.COGNITO_CLIENT_SECRET || undefined,
    redirectUri: `${base}/api/auth/callback`,
  };
}

export function authorizeUrl(env: OAuthEnv, state: string, idp?: string): string {
  const q = new URLSearchParams({
    client_id: env.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: env.redirectUri,
    state,
  });
  // identity_provider sends the user straight to that federated IdP (e.g. a
  // customer's Okta) instead of the Hosted-UI chooser. The name must match a
  // provider registered on the pool (deploy/cognito/add-idp.sh) and enabled on
  // this client; an unknown name just falls back to the chooser.
  if (idp) q.set("identity_provider", idp);
  return `${env.domain}/oauth2/authorize?${q.toString()}`;
}

export function logoutUrl(env: OAuthEnv, returnTo: string): string {
  const q = new URLSearchParams({
    client_id: env.clientId,
    logout_uri: returnTo,
  });
  return `${env.domain}/logout?${q.toString()}`;
}

export interface TokenSet {
  id_token: string;
  access_token: string;
  refresh_token?: string; // absent on refresh_token grant — reuse the stored one
  expires_in: number;
}

// HTTP Basic for confidential clients. Edge-safe base64 (no Node Buffer) so this
// can run from middleware on the edge runtime.
function basicAuthHeader(env: OAuthEnv): string | null {
  if (!env.clientSecret) return null;
  const raw = `${env.clientId}:${env.clientSecret}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw).toString("base64");
  return `Basic ${b64}`;
}

async function tokenRequest(env: OAuthEnv, body: URLSearchParams): Promise<TokenSet | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const basic = basicAuthHeader(env);
  if (basic) headers["Authorization"] = basic;

  const res = await fetch(`${env.domain}/oauth2/token`, { method: "POST", headers, body });
  if (!res.ok) return null;
  return res.json();
}

/** Exchange an authorization code for tokens at the Cognito token endpoint. */
export async function exchangeCode(env: OAuthEnv, code: string): Promise<TokenSet | null> {
  return tokenRequest(
    env,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.clientId,
      code,
      redirect_uri: env.redirectUri,
    })
  );
}

/** Mint a fresh id/access token from a stored refresh token (transparent re-auth). */
export async function refreshTokens(env: OAuthEnv, refreshToken: string): Promise<TokenSet | null> {
  return tokenRequest(
    env,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.clientId,
      refresh_token: refreshToken,
    })
  );
}
