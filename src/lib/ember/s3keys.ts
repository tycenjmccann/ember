/**
 * Ember — S3 key layout (single source of truth).
 *
 * Every artifact lives under a per-tenant prefix:
 *
 *   ember/t/<tenantId>/configs/<userId>/<version>.zip   — CLI config bundle
 *   ember/t/<tenantId>/auth/<userId>/<cli>.json         — subscription credential
 *   ember/t/<tenantId>/resume/<sessionId>/...           — ported transcript + bundle
 *   ember/t/<tenantId>/checkpoint/<convId>/...          — pulled-home transcript
 *
 * Why the tenant prefix when userId (Cognito sub) and sessionId are already
 * globally-unique? Not collision-avoidance — it's the IAM boundary. A per-tenant
 * runtime role (Phase 3) can be scoped to `…/ember/t/<tenantId>/*` so a tenant's
 * compute physically cannot read another tenant's bytes, even if a key leaked.
 * The prefix is the thing that makes that policy expressible.
 *
 * The runtime (Python) and reaper rebuild these same keys from tenant_id +
 * session_id; keep deploy/coding-agent-runtime/main.py::_tenant_prefix in sync
 * with TENANT_ROOT here.
 */

import { DEFAULT_TENANT_ID } from "./identity";
import type { EmberCli } from "./types";

/** Per-tenant root. Everything an IAM policy would scope hangs off this. */
export function tenantRoot(tenantId: string = DEFAULT_TENANT_ID): string {
  return `ember/t/${tenantId}`;
}

export function configKey(tenantId: string, userId: string, version: string): string {
  return `${tenantRoot(tenantId)}/configs/${userId}/${version}.zip`;
}

export function authKey(tenantId: string, userId: string, cli: EmberCli): string {
  return `${tenantRoot(tenantId)}/auth/${userId}/${cli}.json`;
}

/** Prefix the ported transcript + git bundle for a session live under. */
export function resumePrefix(tenantId: string, sessionId: string): string {
  return `${tenantRoot(tenantId)}/resume/${sessionId}/`;
}

export function transcriptKey(tenantId: string, sessionId: string, claudeSessionId: string): string {
  return `${resumePrefix(tenantId, sessionId)}${claudeSessionId}.jsonl`;
}

export function bundleKey(tenantId: string, sessionId: string): string {
  return `${resumePrefix(tenantId, sessionId)}work.bundle`;
}
