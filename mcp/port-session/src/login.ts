/**
 * login.ts — read this laptop's coding-CLI subscription credential and hand it
 * to Ember, so cloud sessions can run on the user's OWN plan (Claude
 * Pro/Max, or a ChatGPT plan for Codex) instead of AWS Bedrock.
 *
 * Claude Code stores its subscription OAuth in:
 *   - macOS:  Keychain service "Claude Code-credentials" → {claudeAiOauth:{accessToken,…}}
 *   - Linux:  ~/.claude/.credentials.json (same shape)
 * A long-lived headless token from `claude setup-token` can also be passed
 * explicitly (preferred — it lasts ~1yr and is built for CI/headless).
 *
 * Codex stores its ChatGPT-plan login at ~/.codex/auth.json — we ship it verbatim.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Cli = "claude" | "codex";

/** Read Claude's subscription OAuth access token from the local machine. */
async function readClaudeToken(): Promise<{ token: string; label?: string } | null> {
  // macOS: the credential lives in the login keychain.
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("security", [
        "find-generic-password", "-s", "Claude Code-credentials", "-w",
      ]);
      const doc = JSON.parse(stdout);
      const oauth = doc.claudeAiOauth || doc.claudeAiOAuth;
      if (oauth?.accessToken) {
        return { token: oauth.accessToken, label: oauth.subscriptionType ? `Claude ${oauth.subscriptionType}` : "Claude plan" };
      }
    } catch {
      /* fall through to the file path */
    }
  }
  // Linux / fallback: the credentials file.
  for (const p of [
    path.join(homedir(), ".claude", ".credentials.json"),
    path.join(process.env.CLAUDE_CONFIG_DIR || "", ".credentials.json"),
  ]) {
    if (!p) continue;
    try {
      const doc = JSON.parse(await readFile(p, "utf8"));
      const oauth = doc.claudeAiOauth || doc.claudeAiOAuth;
      if (oauth?.accessToken) {
        return { token: oauth.accessToken, label: oauth.subscriptionType ? `Claude ${oauth.subscriptionType}` : "Claude plan" };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Read Codex's ChatGPT-plan auth.json from ~/.codex (or $CODEX_HOME). */
async function readCodexAuth(): Promise<{ authJson: unknown; label?: string } | null> {
  const root = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  try {
    const doc = JSON.parse(await readFile(path.join(root, "auth.json"), "utf8"));
    // tokens.account.email or a top-level email, if present, makes a nice label.
    const email =
      doc?.tokens?.account?.email || doc?.account?.email || doc?.email || undefined;
    return { authJson: doc, label: email ? `ChatGPT (${email})` : "ChatGPT plan" };
  } catch {
    return null;
  }
}

/**
 * Gather the local subscription credential for one CLI.
 * `explicitToken` (claude only) overrides the keychain — pass the output of
 * `claude setup-token` for a long-lived headless token.
 * Returns the POST body for /api/ember/auth, or throws with guidance.
 */
export async function gatherLoginBody(
  cli: Cli,
  explicitToken?: string
): Promise<Record<string, unknown>> {
  if (cli === "claude") {
    if (explicitToken?.trim()) {
      return { cli, token: explicitToken.trim(), label: "Claude plan (setup-token)" };
    }
    const c = await readClaudeToken();
    if (!c) {
      throw new Error(
        "No local Claude login found. Sign in with `claude` (or run `claude setup-token` " +
        "for a long-lived token) and pass it: login_cli({cli:'claude', token:'<token>'})."
      );
    }
    return { cli, token: c.token, label: c.label };
  }
  const c = await readCodexAuth();
  if (!c) {
    throw new Error(
      "No ~/.codex/auth.json found. Run `codex login` on this laptop first, then retry."
    );
  }
  return { cli, authJson: c.authJson, label: c.label };
}
