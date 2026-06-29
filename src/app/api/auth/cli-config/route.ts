/**
 * GET /api/auth/cli-config  → public OAuth discovery for the port-session MCP.
 *
 * The MCP's `authenticate` command needs the Hosted-UI domain + the PUBLIC CLI
 * client id to run the PKCE loopback flow. Neither is a secret (the client has no
 * secret, and the domain is public), so this endpoint is unauthenticated — it's
 * under /api/auth/ which the middleware allowlists.
 *
 * Returns 404 when auth isn't configured (personal EMBER_AUTH_DISABLED deploy),
 * so the MCP can tell "no login needed here" from "login available".
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const domain = process.env.COGNITO_DOMAIN;
  // Prefer the dedicated public CLI client; if a deployer hasn't created it yet,
  // there is no secretless client to use — report unconfigured rather than leak
  // the confidential web client id (which would fail PKCE without the secret).
  const cliClientId = process.env.COGNITO_CLI_CLIENT_ID;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!domain || !cliClientId) {
    return NextResponse.json(
      { configured: false, reason: "Cognito CLI client not configured" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    configured: true,
    domain: domain.replace(/\/$/, ""),
    clientId: cliClientId,
    region,
    scopes: "openid email profile",
  });
}
