/**
 * Ember — subscription credential store.
 *
 * The alternative to Bedrock: a session can run on the user's OWN plan
 * (Claude Pro/Max, or a ChatGPT plan for Codex). The laptop's login MCP (or the
 * Account UI) uploads the credential here; the runtime fetches it per session
 * and materializes it (CLAUDE_CODE_OAUTH_TOKEN / ~/.codex/auth.json).
 *
 * Storage:
 *   - Credential bytes → S3 at ember/auth/{userId}/{cli}.json
 *       claude: { token }            (from `claude setup-token`)
 *       codex:  the verbatim auth.json from `codex login`
 *   - "Connected" status → a DynamoDB row keyed "auth:{userId}" in the sessions
 *     table ({ claude?: {...meta}, codex?: {...meta} }). Single-table, no new infra.
 *
 * The token/auth bytes never come back out through the API — only presence +
 * metadata (connectedAt, label). Single-user today (userId "default").
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_USER_ID } from "./sessions";
import { DEFAULT_TENANT_ID } from "./identity";
import { putSecret, deleteSecret, secretsBackend } from "./secrets";
import type { EmberCli } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const keyFor = (userId: string) => `auth:${userId}`;

export interface CliAuthMeta {
  connectedAt: string;
  label?: string; // e.g. "Claude Pro" / the ChatGPT account email if present
}

export interface UserAuthStatus {
  claude?: CliAuthMeta;
  codex?: CliAuthMeta;
  kiro?: CliAuthMeta;
}

export function authConfigured(): boolean {
  // Secrets Manager needs no bucket; the S3 backend does.
  return secretsBackend() === "secretsmanager" || Boolean(ARTIFACT_BUCKET);
}

/** Connected-CLI status for the Account UI (no secret material). */
export async function getAuthStatus(userId: string = DEFAULT_USER_ID): Promise<UserAuthStatus> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(userId) }, ConsistentRead: true })
  );
  const item = res.Item as (UserAuthStatus & { sessionId: string }) | undefined;
  if (!item) return {};
  return { claude: item.claude, codex: item.codex, kiro: item.kiro };
}

async function saveAuthStatus(userId: string, status: UserAuthStatus): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { sessionId: keyFor(userId), ...status } })
  );
}

/**
 * Store a subscription credential for one CLI.
 *   claude → { token }    codex → the auth.json object (verbatim)
 * Writes the bytes to S3 and records connected status in DynamoDB.
 */
export async function putCredential(
  cli: EmberCli,
  cred: Record<string, unknown>,
  opts: { label?: string; userId?: string; tenantId?: string } = {}
): Promise<CliAuthMeta> {
  const userId = opts.userId || DEFAULT_USER_ID;
  const tenantId = opts.tenantId || DEFAULT_TENANT_ID;
  // Bytes go to the configured secrets backend (S3 or Secrets Manager); the
  // DynamoDB row records only presence + label.
  await putSecret(tenantId, userId, cli, cred);
  const meta: CliAuthMeta = { connectedAt: new Date().toISOString(), label: opts.label };
  const status = await getAuthStatus(userId);
  status[cli] = meta;
  await saveAuthStatus(userId, status);
  return meta;
}

/** Disconnect a CLI: delete its credential bytes + clear connected status. */
export async function deleteCredential(
  cli: EmberCli,
  userId: string = DEFAULT_USER_ID,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<void> {
  await deleteSecret(tenantId, userId, cli);
  const status = await getAuthStatus(userId);
  delete status[cli];
  await saveAuthStatus(userId, status);
}
