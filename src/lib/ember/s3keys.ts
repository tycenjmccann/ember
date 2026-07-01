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

/** Prefix the session's ported artifacts (touched-but-untracked deliverables —
 *  generated media, exports, datasets) live under. The runtime lists this prefix
 *  on warm and restores each object into the workspace's .ember/artifacts/. */
export function artifactPrefix(tenantId: string, sessionId: string): string {
  return `${resumePrefix(tenantId, sessionId)}artifacts/`;
}

/** S3 key for one ported artifact, identified by its workspace-relative path.
 *  `rel` MUST be validated (no leading slash, no `..` segment) before this is
 *  called — see safeRelPath. */
export function artifactKey(tenantId: string, sessionId: string, rel: string): string {
  return `${artifactPrefix(tenantId, sessionId)}${rel}`;
}

/** Prefix a pulled-home session's transcript + checkpointed artifacts live under.
 *  Keyed by the conversation's RESUME id (the transcript filename id), which is
 *  what the runtime checkpoints under — NOT the Ember session id. */
export function checkpointPrefix(tenantId: string, resumeId: string): string {
  return `${tenantRoot(tenantId)}/checkpoint/${resumeId}/`;
}

/** Prefix cloud-generated artifacts land under at checkpoint time (the runtime's
 *  _checkpoint_artifacts uploads here). Distinct from the resume/upload prefix,
 *  so the web listing must read both. */
export function checkpointArtifactPrefix(tenantId: string, resumeId: string): string {
  return `${checkpointPrefix(tenantId, resumeId)}artifacts/`;
}

/** Validate an artifact's workspace-relative path: reject absolute paths and any
 *  `..` traversal so a malicious/buggy manifest can't write outside the session's
 *  artifact prefix (server side) or workspace (runtime side). Returns a POSIX rel
 *  path, or null if unsafe. */
export function safeRelPath(rel: string): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/")) return null;
  if (norm.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return norm;
}
