/**
 * Ember — DynamoDB session store.
 *
 * One row per coding conversation, keyed by sessionId (== runtimeSessionId).
 * Single-user for now: every row carries userId "default"; swap for the Cognito
 * `sub` when app-wide SSO lands (no migration — just start writing the real id
 * and filter by it).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  EmberSession,
  EmberSessionSummary,
  SessionWarmth,
} from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";

export const DEFAULT_USER_ID = "default";

// Warmth thresholds (ms since last activity). The coding runtime idles a session
// out at 1800s; mark idle well before that and cold past it.
const WARM_MS = 5 * 60_000;
const IDLE_MS = 30 * 60_000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function warmthOf(updatedAt: string): SessionWarmth {
  const age = Date.now() - new Date(updatedAt).getTime();
  if (age <= WARM_MS) return "warm";
  if (age <= IDLE_MS) return "idle";
  return "cold";
}

export async function getSession(sessionId: string): Promise<EmberSession | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId }, ConsistentRead: true })
  );
  return (res.Item as EmberSession) || null;
}

export async function putSession(session: EmberSession): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: session }));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId } }));
}

// Grace before DynamoDB TTL expires a tombstoned row (and thereby triggers the
// reaper via the table stream). The row is hidden from the user the instant
// deletedAt is set; this only governs how soon the backend cleanup fires. Short
// so reclamation is prompt, but non-zero to absorb clock skew. (Actual TTL delete
// latency is best-effort — usually minutes — which is fine for storage cleanup.)
const REAP_GRACE_S = 60;

/**
 * Soft-delete: stamp the row as deleted and give it a TTL, then return. The row
 * vanishes from the user's list immediately (listSessions filters deletedAt), but
 * survives as the retry handle for backend cleanup. When DynamoDB expires it, the
 * table stream fires the reaper Lambda once — which stops the microVM + purges
 * EFS/S3. No multi-step cleanup runs in the request path, so there's no race to
 * lose: a failed cleanup just re-arms the TTL and fires again.
 */
export async function softDeleteSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  session.deletedAt = new Date().toISOString();
  (session as EmberSession & { ttl?: number }).ttl =
    Math.floor(Date.now() / 1000) + REAP_GRACE_S;
  await putSession(session);
}

export async function listSessions(
  userId: string = DEFAULT_USER_ID
): Promise<EmberSessionSummary[]> {
  const items: EmberSession[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items as EmberSession[]) || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return items
    // Exclude non-session rows that share this table (e.g. config:{userId}
    // metadata written by the config-bundle store) — they have no turns/cli.
    .filter((s) => !String(s.sessionId).startsWith("config:") && s.cli)
    // Hide soft-deleted rows: to the user they're gone the moment DELETE stamps
    // deletedAt; the row lingers only until the reaper finishes backend cleanup.
    .filter((s) => !s.deletedAt)
    .filter((s) => (s.userId || DEFAULT_USER_ID) === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      cli: s.cli,
      authMode: s.authMode,
      repo: s.repo,
      defaultView: s.defaultView,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      warmth: warmthOf(s.updatedAt),
    }));
}
