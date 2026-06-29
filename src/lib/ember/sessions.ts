/**
 * Ember — DynamoDB session store.
 *
 * One row per coding conversation, keyed by sessionId (== runtimeSessionId). Each
 * row carries the owning tenantId (company) + userId (Cognito `sub`). In no-auth
 * deploys both are "default".
 *
 * Phase 1 scopes reads by tenant via a filtered Scan + an explicit ownership
 * check on point reads. The Scan→Query re-key (PK=TENANT#…) is Phase 1 task #4;
 * doing the filtering here first means the access surface is already tenant-safe
 * before the key change lands.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  EmberSession,
  EmberSessionSummary,
  SessionWarmth,
} from "./types";
import { DEFAULT_TENANT_ID, DEFAULT_USER_ID } from "./identity";

export { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "./identity";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";
const TENANT_INDEX = "tenant-index";

/** Tenant a row belongs to, tolerating legacy rows written before tenantId. */
function tenantOf(s: EmberSession): string {
  return s.tenantId || DEFAULT_TENANT_ID;
}

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

/**
 * Raw point read by id. Does NOT enforce ownership — callers in a request path
 * MUST use getOwnedSession instead. Reserved for internal/system paths (e.g. the
 * soft-delete read-modify-write, which re-keys by the same id it was handed).
 */
export async function getSession(sessionId: string): Promise<EmberSession | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId }, ConsistentRead: true })
  );
  return (res.Item as EmberSession) || null;
}

/**
 * Tenant-checked point read for request handlers. Returns null when the row is
 * missing OR belongs to another tenant — callers map both to 404 so a probe
 * can't even distinguish "exists elsewhere" from "doesn't exist". sessionIds are
 * unguessable UUIDs, but this is the actual boundary, not the id space.
 */
export async function getOwnedSession(
  sessionId: string,
  tenantId: string
): Promise<EmberSession | null> {
  const s = await getSession(sessionId);
  if (!s) return null;
  if (tenantOf(s) !== tenantId) return null;
  return s;
}

export async function putSession(session: EmberSession): Promise<void> {
  // Always stamp a tenant. The tenant-index GSI only indexes rows that carry a
  // tenantId, so an unstamped row would silently vanish from listSessions. New
  // rows get their real tenant from the route; this backstops any path that
  // builds an EmberSession without one (and re-indexes legacy rows on rewrite).
  if (!session.tenantId) session.tenantId = DEFAULT_TENANT_ID;
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
export async function softDeleteSession(
  sessionId: string,
  tenantId: string
): Promise<boolean> {
  const session = await getOwnedSession(sessionId, tenantId);
  if (!session) return false; // missing or not this tenant's → no-op
  session.deletedAt = new Date().toISOString();
  (session as EmberSession & { ttl?: number }).ttl =
    Math.floor(Date.now() / 1000) + REAP_GRACE_S;
  await putSession(session);
  return true;
}

/**
 * List a tenant's sessions for the sidebar. Scoped by tenantId (the company),
 * NOT userId — colleagues in the same tenant share a workspace by design; the
 * cross-company boundary is the security one. (Pass a userId too if/when we want
 * per-user views within a tenant.)
 *
 * Queries the tenant-index GSI, so it reads only this tenant's rows — the
 * boundary is enforced by the partition, not a post-Scan filter. config:/auth:
 * metadata rows carry no tenantId and are therefore absent from the index.
 */
export async function listSessions(
  tenantId: string = DEFAULT_TENANT_ID
): Promise<EmberSessionSummary[]> {
  const items: EmberSession[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: TENANT_INDEX,
        KeyConditionExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenantId },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((res.Items as EmberSession[]) || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return items
    // The GSI excludes metadata rows (no tenantId), but a config:/auth: row that
    // ever got a tenant stamp would slip in — belt-and-suspenders.
    .filter((s) => !String(s.sessionId).startsWith("config:") &&
                   !String(s.sessionId).startsWith("auth:") && s.cli)
    // Hide soft-deleted rows: to the user they're gone the moment DELETE stamps
    // deletedAt; the row lingers only until the reaper finishes backend cleanup.
    .filter((s) => !s.deletedAt)
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
