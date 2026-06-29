/**
 * Ember — per-tenant silo registry (Phase 3).
 *
 * A company can be given its OWN compute silo: a dedicated AgentCore runtime
 * (separate microVMs), a dedicated EFS access point (its own root dir + non-root
 * POSIX uid), and a runtime IAM role scoped to ember/t/<tenantId>/*. The mapping
 * lives in one DynamoDB row per tenant, key "tenant:{tenantId}", in the sessions
 * table (single-table — no new infra). deploy/provision-tenant.sh writes it.
 *
 * SAFE FALLBACK: a tenant with no row (or no runtimeArn) transparently uses the
 * shared default runtime (CODING_AGENT_RUNTIME_ARN). So this is a pure additive
 * capability — pool tenants keep working unchanged; only a tenant that's been
 * explicitly siloed routes to its own runtime. That's why turning Phase 3 on for
 * one tenant never touches another.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TENANT_ID } from "./identity";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EMBER_TABLE || "ember-sessions";
const SHARED_RUNTIME_ARN = process.env.CODING_AGENT_RUNTIME_ARN || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const keyFor = (tenantId: string) => `tenant:${tenantId}`;

export interface TenantSilo {
  tenantId: string;
  // Dedicated AgentCore runtime ARN. Absent → the tenant uses the shared runtime.
  runtimeArn?: string;
  // For operator visibility / offboarding (Phase 4); not used for routing.
  efsAccessPointArn?: string;
  runtimeRoleArn?: string;
  createdAt?: string;
}

// Resolved ARNs are stable for the life of a process; cache to keep this off the
// per-turn hot path. A newly-provisioned tenant just needs a deploy/restart (or
// wait out the TTL) to pick up its runtime — acceptable for an operator action.
const cache = new Map<string, { arn: string; at: number }>();
const CACHE_TTL_MS = 60_000;

export async function getTenantSilo(tenantId: string): Promise<TenantSilo | null> {
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(tenantId) } })
    );
    const item = res.Item as (TenantSilo & { sessionId: string }) | undefined;
    if (!item) return null;
    return {
      tenantId,
      runtimeArn: item.runtimeArn,
      efsAccessPointArn: item.efsAccessPointArn,
      runtimeRoleArn: item.runtimeRoleArn,
      createdAt: item.createdAt,
    };
  } catch {
    // A registry read failure must never harden into an outage: fall back to the
    // shared runtime (caller handles the empty string). Returning null does that.
    return null;
  }
}

export async function putTenantSilo(silo: TenantSilo): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { sessionId: keyFor(silo.tenantId), ...silo },
    })
  );
  cache.delete(silo.tenantId);
}

/**
 * The AgentCore runtime ARN a tenant's sessions invoke. The tenant's own runtime
 * if it's been siloed, else the shared default. Returns "" only if neither exists
 * (a misconfigured deploy) — callers already throw on an empty ARN.
 */
export async function resolveRuntimeArn(tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.arn;

  const silo = await getTenantSilo(tenantId);
  const arn = silo?.runtimeArn || SHARED_RUNTIME_ARN;
  if (arn) cache.set(tenantId, { arn, at: Date.now() });
  return arn;
}
