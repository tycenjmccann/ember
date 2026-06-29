/**
 * Ember — subscription-credential storage backend (Phase 4).
 *
 * Subscription creds (a Claude OAuth token / a ChatGPT auth.json) are the most
 * sensitive bytes Ember holds. Two backends, selected by EMBER_SECRETS_BACKEND:
 *
 *   "s3" (default)            — an encrypted object in the artifact bucket, the
 *                               pre-Phase-4 behavior. Unchanged for existing deploys.
 *   "secretsmanager"          — AWS Secrets Manager, one secret per (tenant,user,cli),
 *                               named ember/t/<tenantId>/auth/<userId>/<cli>. Gets
 *                               KMS-at-rest, rotation, audit, and a per-tenant
 *                               runtime role can be scoped to its own secret name
 *                               prefix — a tighter wall than a bucket prefix.
 *
 * Both the app (write) and the runtime (read) honor the same backend + naming, so
 * a deploy flips one env var. The token bytes never round-trip through the API
 * either way — auth-store only ever returns presence + metadata.
 */

import { authKey } from "./s3keys";
import type { EmberCli } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

export type SecretsBackend = "s3" | "secretsmanager";

export function secretsBackend(): SecretsBackend {
  return process.env.EMBER_SECRETS_BACKEND === "secretsmanager" ? "secretsmanager" : "s3";
}

/** Secrets Manager secret name for a credential. Tenant-scoped so a per-tenant
 *  role can be fenced to `ember/t/<tenantId>/*`. Mirrors the S3 key minus the .json. */
export function secretName(tenantId: string, userId: string, cli: EmberCli): string {
  return `ember/t/${tenantId}/auth/${userId}/${cli}`;
}

/** Store a credential. Returns nothing; throws on hard failure. */
export async function putSecret(
  tenantId: string,
  userId: string,
  cli: EmberCli,
  cred: Record<string, unknown>
): Promise<void> {
  if (secretsBackend() === "secretsmanager") {
    const {
      SecretsManagerClient,
      CreateSecretCommand,
      PutSecretValueCommand,
    } = await import("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region: REGION });
    const Name = secretName(tenantId, userId, cli);
    const SecretString = JSON.stringify(cred);
    try {
      // Tag with the tenant so offboarding can find every secret for a tenant.
      await sm.send(
        new CreateSecretCommand({
          Name,
          SecretString,
          Tags: [{ Key: "ember:tenant", Value: tenantId }],
        })
      );
    } catch (e) {
      // Already exists → update the value (idempotent re-connect).
      if ((e as { name?: string }).name === "ResourceExistsException") {
        await sm.send(new PutSecretValueCommand({ SecretId: Name, SecretString }));
      } else {
        throw e;
      }
    }
    return;
  }

  // s3 backend (default, unchanged from pre-Phase-4).
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET not configured");
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: authKey(tenantId, userId, cli),
      Body: JSON.stringify(cred),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    })
  );
}

/** Delete a credential (disconnect). Best-effort: a missing secret is success. */
export async function deleteSecret(
  tenantId: string,
  userId: string,
  cli: EmberCli
): Promise<void> {
  if (secretsBackend() === "secretsmanager") {
    const { SecretsManagerClient, DeleteSecretCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const sm = new SecretsManagerClient({ region: REGION });
    await sm
      .send(
        new DeleteSecretCommand({
          SecretId: secretName(tenantId, userId, cli),
          ForceDeleteWithoutRecovery: true,
        })
      )
      .catch(() => {});
    return;
  }

  if (!ARTIFACT_BUCKET) return;
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  await s3
    .send(new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: authKey(tenantId, userId, cli) }))
    .catch(() => {});
}
