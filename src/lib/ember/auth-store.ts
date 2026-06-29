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
import { authKey } from "./s3keys";
import type { EmberCli } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const keyFor = (userId: string) => `auth:${userId}`;
// S3 key tenant-scoped (ember/t/<tenantId>/auth/…) for the per-tenant IAM
// boundary; the DynamoDB status row stays keyed by the globally-unique userId.
const s3KeyFor = (userId: string, cli: EmberCli, tenantId: string) =>
  authKey(tenantId, userId, cli);

export interface CliAuthMeta {
  connectedAt: string;
  label?: string; // e.g. "Claude Pro" / the ChatGPT account email if present
}

export interface UserAuthStatus {
  claude?: CliAuthMeta;
  codex?: CliAuthMeta;
}

export function authConfigured(): boolean {
  return Boolean(ARTIFACT_BUCKET);
}

/** Connected-CLI status for the Account UI (no secret material). */
export async function getAuthStatus(userId: string = DEFAULT_USER_ID): Promise<UserAuthStatus> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(userId) }, ConsistentRead: true })
  );
  const item = res.Item as (UserAuthStatus & { sessionId: string }) | undefined;
  if (!item) return {};
  return { claude: item.claude, codex: item.codex };
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
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET not configured");
  const userId = opts.userId || DEFAULT_USER_ID;
  const tenantId = opts.tenantId || DEFAULT_TENANT_ID;
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: s3KeyFor(userId, cli, tenantId),
      Body: JSON.stringify(cred),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    })
  );
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
  if (ARTIFACT_BUCKET) {
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    await s3
      .send(new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: s3KeyFor(userId, cli, tenantId) }))
      .catch(() => {});
  }
  const status = await getAuthStatus(userId);
  delete status[cli];
  await saveAuthStatus(userId, status);
}
