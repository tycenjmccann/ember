/**
 * port-session-mcp — Cognito Hosted-UI login (PKCE loopback).
 *
 * Drives `authenticate`: discovers the pool's public CLI client from
 * `<EMBER_URL>/api/auth/cli-config`, opens the Hosted UI in the browser, captures
 * the auth code on a localhost loopback, exchanges it (PKCE, no client secret),
 * and persists the tokens to ~/.ember/credentials.json. auth.ts then reads the
 * id-token from there and refreshes it with the stored refresh token — so the
 * user logs in once, not hourly.
 *
 * Public client + PKCE is the right grant for a CLI: there's no secret to ship,
 * and the code is bound to a one-time verifier the loopback holds in memory.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const CRED_PATH =
  process.env.EMBER_CRED_FILE || join(homedir(), ".ember", "credentials.json");

// Loopback ports registered as callback URLs on the CLI client (setup-cognito.sh).
const LOOPBACK_PORTS = [8717, 8718, 8719];

export interface StoredCreds {
  idToken: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt: number; // epoch seconds
  domain: string;
  clientId: string;
}

interface CliConfig {
  configured: boolean;
  domain: string;
  clientId: string;
  region: string;
  scopes: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fetchCliConfig(emberUrl: string): Promise<CliConfig> {
  const res = await fetch(`${emberUrl}/api/auth/cli-config`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    throw new Error(
      "This deployment has no Cognito CLI client configured. Either it runs with " +
        "EMBER_AUTH_DISABLED=1 (no login needed — leave EMBER_TOKEN unset), or the " +
        "admin must rerun deploy/cognito/setup-cognito.sh to create the public CLI client."
    );
  }
  if (!res.ok) throw new Error(`cli-config returned ${res.status}`);
  const cfg = (await res.json()) as CliConfig;
  if (!cfg.configured) throw new Error("auth not configured on this deployment");
  return cfg;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* fall back to printing the URL (done by the caller) */
  }
}

/** Run the loopback server + Hosted-UI flow; resolve with the token response. */
async function pkceFlow(cfg: CliConfig): Promise<StoredCreds> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  // Bind the loopback first so we know which registered port (= redirect_uri) to use.
  const { server, port } = await bindLoopback();
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl =
    `${cfg.domain}/oauth2/authorize?` +
    new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      scope: cfg.scopes,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  process.stderr.write(`\nOpening browser to sign in:\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const code = await waitForCode(server, state); // resolves on the redirect

  // Exchange the code with PKCE — public client, NO secret.
  const tokenRes = await fetch(`${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text().catch(() => "")}`);
  }
  const tok = (await tokenRes.json()) as {
    id_token: string;
    refresh_token?: string;
    access_token?: string;
    expires_in: number;
  };
  return {
    idToken: tok.id_token,
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: nowSec() + (tok.expires_in || 3600),
    domain: cfg.domain,
    clientId: cfg.clientId,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function bindLoopback(): Promise<{ server: import("node:http").Server; port: number }> {
  for (const port of LOOPBACK_PORTS) {
    const server = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) return { server, port };
  }
  throw new Error(
    `no loopback port free (tried ${LOOPBACK_PORTS.join(", ")}). Close whatever is using them and retry.`
  );
}

function waitForCode(server: import("node:http").Server, expectState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("login timed out after 5 min"));
    }, 300_000);

    server.on("request", (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const done = (msg: string, ok: boolean) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:system-ui;text-align:center;padding-top:3rem">` +
            `<h2>${ok ? "✓ Signed in to Ember" : "Sign-in failed"}</h2>` +
            `<p>${msg}</p><p>You can close this tab.</p></body></html>`
        );
      };
      if (err) {
        done(`Cognito error: ${err}`, false);
        clearTimeout(timeout); server.close();
        reject(new Error(`authorization error: ${err}`));
        return;
      }
      if (!code || state !== expectState) {
        done("Bad or mismatched response (possible CSRF).", false);
        clearTimeout(timeout); server.close();
        reject(new Error("missing code or state mismatch"));
        return;
      }
      done("Return to your terminal.", true);
      clearTimeout(timeout); server.close();
      resolve(code);
    });
  });
}

async function persist(creds: StoredCreds): Promise<void> {
  await mkdir(dirname(CRED_PATH), { recursive: true });
  await writeFile(CRED_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await chmod(CRED_PATH, 0o600);
}

/** Full interactive login. Returns the verified email/subject for a friendly confirm. */
export async function runCognitoLogin(emberUrl: string): Promise<{ email?: string }> {
  const cfg = await fetchCliConfig(emberUrl);
  const creds = await pkceFlow(cfg);
  await persist(creds);
  return { email: emailFromIdToken(creds.idToken) };
}

function emailFromIdToken(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}
