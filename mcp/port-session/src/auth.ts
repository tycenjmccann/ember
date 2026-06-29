/**
 * port-session-mcp — Ember API authentication.
 *
 * Once a deploy turns on Cognito auth, every /api/ember/* call must carry a
 * verified identity. The backend middleware accepts a Cognito id-token as a
 * Bearer header, so the MCP attaches one. Token sources, in order:
 *
 *   1. EMBER_TOKEN env var — explicit override, wins if present.
 *   2. ~/.ember/credentials.json — written by the `authenticate` command (PKCE
 *      Hosted-UI login). Carries the id-token + a refresh token; this module
 *      auto-refreshes the id-token when it's near expiry, so the user logs in
 *      ONCE and never hand-pastes or re-pastes a token.
 *   3. ~/.ember/token — a plain id-token the user dropped in (legacy / manual).
 *
 * Nothing set → no header. Correct for a personal deploy (EMBER_AUTH_DISABLED=1).
 * Against an auth'd deploy the call 401s; emberFetch (below) catches that, runs
 * the Hosted-UI login automatically, and retries — so the user never hand-runs
 * `/mcp__port-session__auth` (it stays available for signing in ahead of time).
 *
 * The token is sent ONLY to EMBER_URL — never to presigned S3 URLs (their SigV4
 * must not see a third-party bearer). Only the helpers here add it.
 */

import { readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CRED_PATH, runCognitoLogin, type StoredCreds } from "./cognito-login.js";

const LEGACY_TOKEN_PATH = process.env.EMBER_TOKEN_FILE || join(homedir(), ".ember", "token");
// Refresh when the id-token has under this many seconds left (covers clock skew
// + the round trip), so a turn never starts with an about-to-expire token.
const REFRESH_SKEW_S = 120;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function readCreds(): Promise<StoredCreds | null> {
  try {
    return JSON.parse(await readFile(CRED_PATH, "utf8")) as StoredCreds;
  } catch {
    return null;
  }
}

async function writeCreds(c: StoredCreds): Promise<void> {
  await writeFile(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(CRED_PATH, 0o600).catch(() => {});
}

/** Exchange the stored refresh token for a fresh id-token (public client, no secret). */
async function refresh(creds: StoredCreds): Promise<StoredCreds | null> {
  if (!creds.refreshToken) return null;
  try {
    const res = await fetch(`${creds.domain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: creds.clientId,
        refresh_token: creds.refreshToken,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const tok = (await res.json()) as {
      id_token: string;
      access_token?: string;
      expires_in: number;
      refresh_token?: string; // Cognito usually omits on refresh; keep the old one
    };
    const updated: StoredCreds = {
      ...creds,
      idToken: tok.id_token,
      accessToken: tok.access_token ?? creds.accessToken,
      refreshToken: tok.refresh_token ?? creds.refreshToken,
      expiresAt: nowSec() + (tok.expires_in || 3600),
    };
    await writeCreds(updated);
    return updated;
  } catch {
    return null;
  }
}

async function tokenFromCreds(): Promise<string | null> {
  const creds = await readCreds();
  if (!creds?.idToken) return null;
  if (creds.expiresAt - nowSec() > REFRESH_SKEW_S) return creds.idToken; // still valid
  const refreshed = await refresh(creds);
  if (refreshed) return refreshed.idToken;
  // Refresh failed (refresh token expired/revoked) — return the stale token so the
  // 401 is explicit (prompting re-auth) rather than silently sending nothing.
  return creds.idToken;
}

async function tokenFromLegacyFile(): Promise<string | null> {
  try {
    return (await readFile(LEGACY_TOKEN_PATH, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bearer token fresh on each call (the credentials file is the source
 * of truth and may be refreshed between calls). The refresh round trip only fires
 * within REFRESH_SKEW_S of expiry, so steady-state this is a cheap local read.
 */
async function resolveToken(): Promise<string | null> {
  const fromEnv = (process.env.EMBER_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  return (await tokenFromCreds()) || (await tokenFromLegacyFile());
}

/**
 * Authorization header for an Ember API call (empty object when no token — the
 * personal/no-auth case). Spread into a fetch's headers.
 */
export async function emberAuthHeaders(): Promise<Record<string, string>> {
  const token = await resolveToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// One in-flight interactive login at a time — if two API calls 401 at once, they
// share the same browser flow instead of opening two tabs.
let loginInFlight: Promise<void> | null = null;

async function ensureLogin(emberUrl: string): Promise<void> {
  if (!loginInFlight) {
    loginInFlight = runCognitoLogin(emberUrl)
      .then(() => {})
      .finally(() => {
        loginInFlight = null;
      });
  }
  return loginInFlight;
}

/**
 * fetch() against the Ember API that transparently logs in on a 401.
 *
 * Steady state it's a plain authed fetch. When the token is missing/expired and
 * the deploy has auth on, the first call 401s → we open the Hosted-UI login
 * (PKCE loopback), persist the fresh credentials, and retry ONCE. So port/pull/
 * sync just open the browser when needed instead of erroring with "run /auth".
 *
 * `init.headers` is merged AFTER the auth header so an explicit Authorization
 * (or Content-Type) the caller passes still wins. The retried request re-reads
 * the now-fresh token. A personal deploy (no auth) never 401s, so this is inert.
 */
export async function emberFetch(
  emberUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const build = async (): Promise<RequestInit> => ({
    ...init,
    headers: { ...(await emberAuthHeaders()), ...(init.headers as Record<string, string>) },
  });

  const url = `${emberUrl}${path}`;
  let res = await fetch(url, await build());
  if (res.status !== 401) return res;

  // 401: try an interactive login, then retry once. If login itself fails
  // (e.g. no CLI client configured / user cancelled), surface the ORIGINAL 401
  // so the caller's error message is about the request, not the login attempt.
  try {
    await ensureLogin(emberUrl);
  } catch {
    return res;
  }
  res = await fetch(url, await build());
  return res;
}
