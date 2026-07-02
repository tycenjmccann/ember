/**
 * GET /api/ember/github/manifest  → one-time GitHub App creation (operator).
 *
 * Two phases of the GitHub App Manifest flow:
 *   1. No ?code — render a page that auto-POSTs an App manifest to GitHub. The
 *      operator confirms on GitHub, which creates the App and redirects back here.
 *   2. ?code=<temp> — exchange it for the created App's id + private key, store
 *      them in the secrets backend (ember/github-app), and bounce to /ember.
 *
 * Gated to admins: creating the App writes the deploy-level master credential.
 */

import { NextRequest, NextResponse } from "next/server";
import { exchangeManifestCode, resetGithubAppConfigCache } from "@/lib/ember/github-app";
import { putGithubAppConfig } from "@/lib/ember/secrets";
import { isAdmin } from "@/lib/ember/identity";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const base = appBase(request);

  if (!isAdmin(request)) {
    return NextResponse.redirect(`${base}/ember?github=forbidden`);
  }

  const code = request.nextUrl.searchParams.get("code");

  // Phase 2 — GitHub returned a temporary code; convert it to App credentials.
  if (code) {
    try {
      const app = await exchangeManifestCode(code);
      await putGithubAppConfig({
        appId: app.appId,
        privateKey: app.privateKey,
        slug: app.slug,
        webhookSecret: app.webhookSecret,
      });
      resetGithubAppConfigCache();
      // Send the operator to GitHub to install the freshly created App.
      return NextResponse.redirect(`https://github.com/apps/${app.slug}/installations/new`);
    } catch (err) {
      console.error("[ember] github manifest exchange error:", err);
      return NextResponse.redirect(`${base}/ember?github=app_error`);
    }
  }

  // Phase 1 — render an auto-submitting manifest form. The App installs bounce to
  // the connect callback; the App-creation code returns to THIS route.
  const manifest = {
    name: process.env.GITHUB_APP_NAME || "Ember",
    url: base,
    hook_attributes: { active: false },
    redirect_url: `${base}/api/ember/github/manifest`,
    callback_urls: [`${base}/api/ember/github/callback`],
    setup_url: `${base}/api/ember/github/callback`,
    public: false,
    default_permissions: { contents: "write", metadata: "read" },
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creating Ember GitHub App…</title></head>
<body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<form id="f" method="post" action="https://github.com/settings/apps/new">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<p>Redirecting to GitHub to create the Ember app…</p>
<script>document.getElementById('f').submit();</script>
</body></html>`;

  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
