/**
 * Ember — GitHub App connection store.
 *
 * Records which GitHub App installation a user connected, so the hub can mint
 * short-lived clone tokens for their sessions. Only the installation_id + display
 * metadata are stored (a DynamoDB row keyed "github:{userId}" in the sessions
 * table). The App's private key lives in the secrets backend (see secrets.ts);
 * the minted tokens are never persisted. Mirrors auth-store.ts.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_USER_ID } from "./sessions";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const keyFor = (userId: string) => `github:${userId}`;

interface GithubConnection {
  installationId: string;
  account?: string; // the org/user login the App is installed on
  repoSelection?: "all" | "selected";
  repositories?: string[]; // short names when selection === "selected"
  connectedAt: string;
}

export async function getGithubConnection(
  userId: string = DEFAULT_USER_ID
): Promise<GithubConnection | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(userId) }, ConsistentRead: true })
  );
  const item = res.Item as (GithubConnection & { sessionId: string }) | undefined;
  if (!item?.installationId) return null;
  return {
    installationId: item.installationId,
    account: item.account,
    repoSelection: item.repoSelection,
    repositories: item.repositories,
    connectedAt: item.connectedAt,
  };
}

export async function putGithubConnection(
  conn: GithubConnection,
  userId: string = DEFAULT_USER_ID
): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { sessionId: keyFor(userId), ...conn } })
  );
}

export async function deleteGithubConnection(userId: string = DEFAULT_USER_ID): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId: keyFor(userId) } }));
}
