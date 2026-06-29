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

export function authorizeUrl(env: OAuthEnv, state: string): string {
  const q = new URLSearchParams({
    client_id: env.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: env.redirectUri,
    state,
  });
  return `${env.domain}/oauth2/authorize?${q.toString()}`;
}

export function logoutUrl(env: OAuthEnv, returnTo: string): string {
  const q = new URLSearchParams({
    client_id: env.clientId,
    logout_uri: returnTo,
  });
  return `${env.domain}/logout?${q.toString()}`;
}

/** Exchange an authorization code for tokens at the Cognito token endpoint. */
export async function exchangeCode(
  env: OAuthEnv,
  code: string
): Promise<{ id_token: string; access_token: string; expires_in: number } | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.clientId,
    code,
    redirect_uri: env.redirectUri,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Confidential clients authenticate with HTTP Basic at the token endpoint.
  if (env.clientSecret) {
    const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }

  const res = await fetch(`${env.domain}/oauth2/token`, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok) return null;
  return res.json();
}
