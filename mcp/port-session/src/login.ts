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
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Cli = "claude" | "codex" | "kiro";

/** Path to the kiro-cli SQLite store (mirrors cli-adapter.kiroDbPath). */
function kiroDbPath(): string {
  if (process.env.KIRO_HOME) return path.join(process.env.KIRO_HOME, "data.sqlite3");
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(xdg, "kiro-cli", "data.sqlite3");
}

/** Read the IDC/SSO login credential kiro stores in auth_kv (the OAuth token +
 *  the device-registration client). Both are portable JSON (PKCE refresh token +
 *  client_id/secret), so a Linux microVM can refresh against IDC headlessly. */
function readKiroIdcAuth(): { authKv: Record<string, string>; label?: string } | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(kiroDbPath(), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        "SELECT key, value FROM auth_kv WHERE key IN ('kirocli:odic:token','kirocli:odic:device-registration')"
      )
      .all() as Array<{ key: string; value: string }>;
    const authKv: Record<string, string> = {};
    for (const r of rows) authKv[r.key] = r.value;
    if (!authKv["kirocli:odic:token"]) return null; // no login token → not signed in
    let label = "Kiro (IDC SSO)";
    try {
      const tok = JSON.parse(authKv["kirocli:odic:token"]) as { start_url?: string };
      if (tok.start_url) label = `Kiro IDC (${tok.start_url})`;
    } catch {
      /* label stays generic */
    }
    return { authKv, label };
  } finally {
    db.close();
  }
}

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
  if (cli === "kiro") {
    // Kiro is bring-your-own-credential (no Bedrock). Two auth paths:
    //   1. Access key (kiro.dev consumer accounts): explicit paste or $KIRO_API_KEY.
    //   2. IDC / Identity Center SSO (enterprise): the portable OAuth token +
    //      device registration kiro stores in its DB — a Linux microVM refreshes
    //      against IDC with these, no keychain/device binding.
    const key = explicitToken?.trim() || process.env.KIRO_API_KEY?.trim();
    if (key) {
      const fromEnv = !explicitToken?.trim();
      return { cli, token: key, label: fromEnv ? "Kiro (access key, $KIRO_API_KEY)" : "Kiro access key" };
    }
    const idc = readKiroIdcAuth();
    if (idc) {
      return { cli, authKv: idc.authKv, label: idc.label };
    }
    throw new Error(
      "No Kiro credential found. Either sign in with `kiro-cli login` (IDC / Identity Center) " +
      "and retry, or — for a kiro.dev consumer account — generate an access key (Account → " +
      "access keys) and pass it: login_cli({cli:'kiro', token:'<key>'})."
    );
  }
  const c = await readCodexAuth();
  if (!c) {
    throw new Error(
      "No ~/.codex/auth.json found. Run `codex login` on this laptop first, then retry."
    );
  }
  return { cli, authJson: c.authJson, label: c.label };
}
