/**
 * port-session-mcp — Ember API authentication.
 *
 * Once a deploy turns on Cognito auth (Phase 1), every /api/ember/* call must
 * carry a verified identity. The backend middleware accepts a Cognito id-token
 * as a Bearer header, so the MCP attaches one to its API calls.
 *
 * Token source, in order:
 *   1. EMBER_TOKEN env var (set in the MCP server registration) — wins if present.
 *   2. ~/.ember/token  — a file the user drops their id-token into (so they don't
 *      have to re-register the MCP each time the token rotates). $EMBER_TOKEN_FILE
 *      overrides the path.
 *
 * When neither is set we send no header. That's correct for a personal deploy
 * (EMBER_AUTH_DISABLED=1) where the backend doesn't require auth; against an
 * auth'd deploy the call will get a 401, and the error surfaced to the user tells
 * them to set EMBER_TOKEN — far better than a silent cross-tenant hole.
 *
 * The token is NEVER sent anywhere but EMBER_URL — in particular not to the
 * presigned S3 URLs (those carry their own SigV4 and must not see a third-party
 * bearer). Only the helpers here add it, and only EMBER_URL fetches use them.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | null | undefined; // undefined = not yet resolved

async function resolveToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const fromEnv = (process.env.EMBER_TOKEN || "").trim();
  if (fromEnv) return (cached = fromEnv);
  const path = process.env.EMBER_TOKEN_FILE || join(homedir(), ".ember", "token");
  try {
    const t = (await readFile(path, "utf8")).trim();
    cached = t || null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Authorization header for an Ember API call (empty object when no token — the
 * personal/no-auth case). Spread into a fetch's headers.
 */
export async function emberAuthHeaders(): Promise<Record<string, string>> {
  const token = await resolveToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
