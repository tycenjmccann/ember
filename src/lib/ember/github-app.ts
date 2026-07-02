/**
 * Ember — GitHub App installation tokens.
 *
 * The safe replacement for the shared long-lived GITHUB_PAT. The App's private
 * key lives ONLY here (the hub), in the secrets backend under `ember/github-app`;
 * it NEVER enters the microVM. Per clone we sign a short-lived App JWT, exchange
 * it for an installation access token (~1h, optionally scoped to specific repos),
 * and hand THAT to the runtime in the invoke payload. The agent can only ever see
 * the expiring, narrow token — not the master key.
 *
 * See docs/github-app-auth.md for the full design + trust boundary.
 */

import { SignJWT, importPKCS8 } from "jose";
import { createPrivateKey, createHmac, timingSafeEqual } from "crypto";
import { getGithubAppConfig } from "./secrets";
import { getGithubConnection } from "./github-store";

const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";

export interface GithubAppConfig {
  appId: string;
  privateKey: string; // PEM (PKCS#8 or PKCS#1)
}

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO 8601
}

/** True when the App is configured (App ID + private key present in the backend). */
let _configChecked = false;
let _config: GithubAppConfig | null = null;

async function loadConfig(): Promise<GithubAppConfig | null> {
  if (_configChecked) return _config;
  _config = await getGithubAppConfig();
  _configChecked = true;
  return _config;
}

export async function githubAppConfigured(): Promise<boolean> {
  return Boolean(await loadConfig());
}

/** Invalidate the cached config (after an operator (re)creates the App). */
export function resetGithubAppConfigCache(): void {
  _configChecked = false;
  _config = null;
}

// GitHub App JWTs live at most 10 min; use 9 to leave clock-skew margin. GitHub
// also rejects an `iat` in the future, so back-date it 60s.
async function appJwt(cfg: GithubAppConfig): Promise<string> {
  // PKCS#1 ("BEGIN RSA PRIVATE KEY") isn't accepted by importPKCS8; GitHub hands
  // out PKCS#1, so convert. jose only imports PKCS#8 — we normalize below.
  const key = await importPrivateKey(cfg.privateKey);
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 9 * 60)
    .setIssuer(cfg.appId)
    .sign(key);
}

// GitHub distributes the App key as PKCS#1 (`BEGIN RSA PRIVATE KEY`). jose's
// importPKCS8 wants PKCS#8 (`BEGIN PRIVATE KEY`). Convert PKCS#1 → PKCS#8 via
// Node's crypto so operators can paste the key exactly as GitHub gave it.
async function importPrivateKey(pem: string) {
  const normalized = pem.includes("BEGIN RSA PRIVATE KEY")
    ? createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString()
    : pem;
  return importPKCS8(normalized, "RS256");
}

// Cache minted tokens per (installation + repo scope) until 5 min before expiry.
// A warm session can fire many turns; minting each time would be needless GitHub
// API load and latency.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const _tokenCache = new Map<string, InstallationToken>();

function cacheKey(installationId: string, repositories?: string[]): string {
  return `${installationId}::${(repositories || []).slice().sort().join(",")}`;
}

/**
 * Mint (or reuse a cached) installation access token. `repositories` (short
 * names, e.g. ["ember"]) narrows the token to just those repos when provided; a
 * whole-installation token is issued otherwise. Throws if the App isn't
 * configured or GitHub rejects the request — callers fall back to GITHUB_PAT.
 */
export async function mintInstallationToken(
  installationId: string,
  repositories?: string[]
): Promise<InstallationToken> {
  const cfg = await loadConfig();
  if (!cfg) throw new Error("GitHub App is not configured (ember/github-app secret missing)");

  const ck = cacheKey(installationId, repositories);
  const cached = _tokenCache.get(ck);
  if (cached && Date.parse(cached.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
    return cached;
  }

  const jwt = await appJwt(cfg);
  const body: Record<string, unknown> = {};
  if (repositories?.length) body.repositories = repositories;

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`installation token mint failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { token: string; expires_at: string };
  const minted: InstallationToken = { token: json.token, expiresAt: json.expires_at };
  _tokenCache.set(ck, minted);
  return minted;
}

export interface CloneTokenResult {
  /** The minted installation token, if one was issued. */
  token?: string;
  /** True when the user has a GitHub App installation connected. When this is
   *  true but `token` is undefined, the mint was DENIED (repo out of the
   *  selected-repo scope, installation revoked, GitHub error) — the runtime must
   *  NOT fall back to the operator's GITHUB_PAT, or it would clone with broader
   *  access than the user's App scope allows. */
  connected: boolean;
}

/**
 * Clone token for a user's session. Never throws. The `connected` flag lets the
 * caller/runtime tell two cases apart that must behave differently:
 *   - not connected (App unconfigured OR user hasn't installed) → `{connected:
 *     false}` → GITHUB_PAT fallback is legitimate (personal-deploy path).
 *   - connected but mint failed/denied → `{connected: true, token: undefined}` →
 *     fallback is FORBIDDEN; the runtime clears creds so the clone fails cleanly
 *     inside the user's chosen App scope rather than escalating to the PAT.
 * `repo` scopes the token to just that repo when the install was selective.
 */
export async function cloneTokenForUser(
  userId: string,
  repo?: string
): Promise<CloneTokenResult> {
  if (!(await githubAppConfigured())) return { connected: false };
  const conn = await getGithubConnection(userId).catch(() => null);
  if (!conn?.installationId) return { connected: false };
  try {
    // Scope to the single repo when we can name it (owner/name → name). A
    // whole-installation token otherwise (e.g. "list my repos" with no repo yet).
    const shortName = repo?.split("/").filter(Boolean).pop();
    const scope =
      conn.repoSelection === "selected" && shortName ? [shortName] : undefined;
    const { token } = await mintInstallationToken(conn.installationId, scope);
    return { token, connected: true };
  } catch {
    // Connected, but GitHub declined the scoped mint → stay connected with no
    // token so the caller enforces scope instead of leaking the PAT.
    return { connected: true };
  }
}

/** Fetch an installation's account + repo-selection metadata (for the connect
 *  callback). Uses the App JWT. Returns null on any failure. */
export async function getInstallation(installationId: string): Promise<{
  account?: string;
  repoSelection?: "all" | "selected";
} | null> {
  try {
    const cfg = await loadConfig();
    if (!cfg) return null;
    const jwt = await appJwt(cfg);
    const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      account?: { login?: string };
      repository_selection?: "all" | "selected";
    };
    return {
      account: json.account?.login,
      repoSelection: json.repository_selection,
    };
  } catch {
    return null;
  }
}

// ─── Install state (CSRF / installation-binding guard) ──────────────────────
//
// GitHub's install redirect does NOT tell us WHO initiated it — the callback
// just gets ?installation_id=. Without a check, any signed-in user could hit the
// callback with someone else's installation id and bind it to their own account,
// then mint tokens for that org's repos. We defend with a signed `state`: the
// install route issues `userId.expiry.hmac` (keyed off the App private key the
// hub already holds), GitHub echoes it back on the callback, and we verify it
// matches the signed-in user and hasn't expired before storing the installation.

const STATE_TTL_MS = 15 * 60 * 1000; // an install flow completes in minutes.

async function stateKey(): Promise<Buffer> {
  // Derive a stable HMAC key from the App private key — a secret the hub holds
  // and the microVM never sees. No extra config to provision or rotate.
  const cfg = await loadConfig();
  const material = cfg?.privateKey || process.env.GITHUB_APP_PRIVATE_KEY || "";
  if (!material) throw new Error("GitHub App not configured; cannot sign install state");
  return createHmac("sha256", "ember/github-install-state").update(material).digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Mint a signed state token binding an install flow to `userId`. */
export async function issueInstallState(userId: string): Promise<string> {
  const key = await stateKey();
  const payload = `${encodeURIComponent(userId)}.${Date.now() + STATE_TTL_MS}`;
  return `${payload}.${sign(payload, key)}`;
}

/** Verify a state token came from us, hasn't expired, and matches `userId`. */
export async function verifyInstallState(state: string, userId: string): Promise<boolean> {
  try {
    const parts = state.split(".");
    if (parts.length !== 3) return false;
    const [encUser, expiryStr, mac] = parts;
    const key = await stateKey();
    const expected = sign(`${encUser}.${expiryStr}`, key);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    if (Date.now() > Number(expiryStr)) return false;
    return decodeURIComponent(encUser) === userId;
  } catch {
    return false;
  }
}

/** Exchange a manifest `code` for a created App's credentials (operator setup). */
export async function exchangeManifestCode(code: string): Promise<{
  appId: string;
  privateKey: string;
  slug: string;
  htmlUrl: string;
  webhookSecret?: string;
}> {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`manifest conversion failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    id: number;
    slug: string;
    html_url: string;
    pem: string;
    webhook_secret?: string;
  };
  return {
    appId: String(json.id),
    privateKey: json.pem,
    slug: json.slug,
    htmlUrl: json.html_url,
    webhookSecret: json.webhook_secret,
  };
}
