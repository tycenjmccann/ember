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
import { EMBER_LOGO_DATA_URI } from "./ember-logo.js";

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
  // `start` is a cmd.exe builtin (no standalone exe); xdg-open may be absent on
  // headless Linux. spawn reports those as an async 'error' event, not a throw,
  // so swallow both paths — the URL is always printed to stderr by the caller.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
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

/**
 * Ember-branded loopback callback page — "night woods, one live ember."
 *
 * Editorial dark: the real Ember mark breathing at center over a cold forest
 * floor, sparks lifting off it, a warm serif headline and a hairline ember rule.
 * Self-contained (inline CSS + the logo as a base64 data URI, system/serif fonts
 * only) so it renders identically offline — this is a localhost loopback page.
 * On failure the ember goes ashen and the sparks stop. UTF-8 declared so no glyph
 * mangling. Honors prefers-reduced-motion.
 */
function callbackHtml(ok: boolean, msg: string): string {
  const title = ok ? "You're signed in." : "That didn't take.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? "Signed in to Ember" : "Sign-in failed"}</title>
<style>
  :root { color-scheme: dark; --bone:#f6f0e8; --smoke:rgba(203,196,186,.66); --ash:rgba(140,130,120,.6); --link:#ff9d4d; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; position: relative; overflow: hidden;
    background: radial-gradient(120% 80% at 50% -18%, #241610 0%, #120c09 42%, #08060a 72%, #000 100%);
    color: var(--bone);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: -0.01em;
  }
  body::before { /* film grain */
    content:""; position:fixed; inset:0; pointer-events:none; z-index:3; opacity:.05; mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  body::after { /* low warm horizon */
    content:""; position:fixed; left:50%; bottom:-30%; z-index:0; width:780px; height:520px; transform:translateX(-50%);
    background:radial-gradient(50% 50% at 50% 50%, rgba(255,106,0,.16), transparent 70%); pointer-events:none;
  }
  .stage { position: relative; z-index: 2; text-align: center; padding: 2rem; }
  .kicker { font-size:.72rem; font-weight:600; letter-spacing:.42em; text-transform:uppercase; color:var(--ash);
    margin:0 0 2.4rem; padding-left:.42em; animation:fade 1s ease .1s both; }
  .ember-wrap { position: relative; width: 132px; height: 132px; margin: 0 auto 2.2rem; }
  .coals { width: 100%; height: 100%; display: block; filter: drop-shadow(0 0 30px rgba(255,90,0,.5));
    animation: breathe 3.4s ease-in-out infinite; transform-origin: 50% 62%; }
  .spark { position:absolute; bottom:34%; width:3px; height:3px; border-radius:50%; background:#ffd089;
    box-shadow:0 0 6px 1px rgba(255,140,40,.9); opacity:0; pointer-events:none; }
  .spark.s1 { left:42%; animation:riseSpark 2.6s ease-out .4s infinite; }
  .spark.s2 { left:54%; animation:riseSpark 3.2s ease-out 1.3s infinite; --dx:-14px; }
  .spark.s3 { left:36%; animation:riseSpark 2.9s ease-out 2.1s infinite; --dx:10px; }
  .spark.s4 { left:60%; animation:riseSpark 3.5s ease-out 2.7s infinite; --dx:-8px; }
  .spark.s5 { left:48%; animation:riseSpark 3.0s ease-out 1.8s infinite; --dx:6px; }
  h1 { margin:0 0 .6rem; font-weight:500; font-size:2.15rem; line-height:1.05; letter-spacing:-0.015em; color:var(--bone);
    font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
    animation:rise 1s cubic-bezier(.2,.85,.25,1) .18s both; }
  .lede { margin:0 auto; max-width:32ch; font-size:1rem; line-height:1.5; color:var(--smoke);
    animation:rise 1s cubic-bezier(.2,.85,.25,1) .28s both; }
  .rule { width:64px; height:1px; margin:2rem auto 0;
    background:linear-gradient(90deg, transparent, rgba(255,106,0,.5), transparent); animation:fade 1.2s ease .6s both; }
  .hint { margin:2rem 0 0; font-size:.8rem; color:var(--ash); animation:fade 1.2s ease .5s both; }
  body.failed { background: radial-gradient(120% 80% at 50% -18%, #16130f 0%, #0d0b09 45%, #060505 75%, #000 100%); }
  body.failed::after { background: radial-gradient(50% 50% at 50% 50%, rgba(120,120,120,.06), transparent 70%); }
  body.failed .coals { animation:none; filter:saturate(.12) brightness(.55) drop-shadow(0 0 10px rgba(0,0,0,.6)); }
  body.failed .spark { display:none; }
  body.failed .rule { background:linear-gradient(90deg, transparent, rgba(140,130,120,.4), transparent); }
  @keyframes breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.035)} }
  @keyframes riseSpark { 0%{opacity:0;transform:translate(0,0) scale(1)} 12%{opacity:1}
    100%{opacity:0;transform:translate(var(--dx,4px),-104px) scale(.3)} }
  @keyframes rise { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:none} }
  @keyframes fade { from{opacity:0} to{opacity:1} }
  @media (prefers-reduced-motion: reduce) { .coals,.spark,.stage *{animation:none!important} .spark{display:none} }
</style></head>
<body class="${ok ? "" : "failed"}">
  <main class="stage">
    <p class="kicker">Ember&nbsp;· Session</p>
    <div class="ember-wrap">
      <img class="coals" src="${EMBER_LOGO_DATA_URI}" alt="" aria-hidden="true">
      <span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span>
      <span class="spark s4"></span><span class="spark s5"></span>
    </div>
    <h1>${title}</h1>
    <p class="lede">${msg}</p>
    <div class="rule"></div>
    <p class="hint">Safe to close this tab.</p>
  </main>
</body></html>`;
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
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(ok, msg));
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
      done("Your workspace is warm. Head back to the terminal — Ember is ready to pick up where you left off.", true);
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
