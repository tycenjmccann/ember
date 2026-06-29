#!/usr/bin/env python3
"""
verify-kiro.py — kiro-specific smoke test against the deployed AgentCore runtime.

Proves the one thing the local unit tests couldn't: a real headless
`kiro-cli chat` turn runs in the cloud image, learns its conversation_id from the
SQLite store, resumes by that id, and checkpoints the grown row back. Needs a
Kiro access key (env KIRO_API_KEY) since kiro has no Bedrock fallback.

It uploads the key to the same S3 location the runtime fetches per turn
(ember/t/<tenant>/auth/<user>/kiro.json), then drives two turns + a checkpoint
directly via InvokeAgentRuntime.

Usage:
  source deploy/config.sh
  export CODING_AGENT_RUNTIME_ARN=...   # from deploy.py
  export KIRO_API_KEY=ksk_...           # your kiro.dev access key
  python3 deploy/verify-kiro.py
"""
from __future__ import annotations

import json
import os
import sys
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
USER = os.environ.get("EMBER_TEST_USER", "default")
TENANT = os.environ.get("EMBER_TEST_TENANT", "default")


def _tenant_prefix(t: str) -> str:
    return f"ember/t/{t}"


def main() -> None:
    arn = os.environ.get("CODING_AGENT_RUNTIME_ARN")
    bucket = os.environ.get("ARTIFACT_BUCKET")
    key = os.environ.get("KIRO_API_KEY")
    if not arn:
        sys.exit("CODING_AGENT_RUNTIME_ARN not set (run deploy.py, export the ARN)")
    if not bucket:
        sys.exit("ARTIFACT_BUCKET not set (source deploy/config.sh / .env.local)")
    if not key:
        sys.exit("KIRO_API_KEY not set — generate one at kiro.dev (Account → access keys)")

    s3 = boto3.client("s3", region_name=REGION)
    cred_key = f"{_tenant_prefix(TENANT)}/auth/{USER}/kiro.json"
    print(f"  Uploading test Kiro key → s3://{bucket}/{cred_key}")
    s3.put_object(Bucket=bucket, Key=cred_key,
                  Body=json.dumps({"token": key}).encode(), ContentType="application/json")

    rt = boto3.client("bedrock-agentcore", region_name=REGION,
                      config=Config(read_timeout=900, retries={"max_attempts": 0}))
    # runtimeSessionId requires >= 33 chars; cc- + 32-hex uuid = 35.
    session_id = f"cc-{uuid.uuid4().hex}{uuid.uuid4().hex[:0]}"

    def invoke(payload: dict) -> dict:
        payload.setdefault("cli", "kiro")
        payload.setdefault("session_id", session_id)
        payload.setdefault("user_id", USER)
        payload.setdefault("tenant_id", TENANT)
        res = rt.invoke_agent_runtime(
            agentRuntimeArn=arn, runtimeSessionId=session_id,
            payload=json.dumps(payload).encode(), contentType="application/json",
            accept="application/json")
        body = res["response"].read().decode() if res.get("response") else ""
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"_raw": body}

    print("  [1/3] First kiro turn (cold start can take 1-2 min)...")
    r1 = invoke({"prompt": "Reply with exactly the token KIRO_TURN_1 and nothing else."})
    if r1.get("error"):
        sys.exit(f"  ✗ turn 1 failed: {r1['error']}")
    conv = r1.get("claude_session_id")
    print(f"      reply: {str(r1.get('response'))[:80]!r}")
    print(f"      conversation_id learned: {conv}")
    if not conv:
        sys.exit("  ✗ no conversation_id learned — the SQLite row discovery failed")

    print("  [2/3] Resume that conversation by id...")
    r2 = invoke({"prompt": "What token did I ask you to reply with a moment ago?",
                 "claude_session_id": conv})
    if r2.get("error"):
        sys.exit(f"  ✗ resume failed: {r2['error']}")
    print(f"      reply: {str(r2.get('response'))[:120]!r}")
    remembered = "KIRO_TURN_1" in str(r2.get("response", ""))
    print(f"      remembered prior turn: {'✓' if remembered else '✗ (context not carried)'}")

    print("  [3/3] Checkpoint the grown transcript back to S3...")
    cp = invoke({"checkpoint": True, "resume_session_id": conv})
    if cp.get("error"):
        sys.exit(f"  ✗ checkpoint failed: {cp['error']}")
    print(f"      checkpoint: key={cp.get('key')} bytes={cp.get('bytes')}")
    if not cp.get("key"):
        sys.exit("  ✗ checkpoint returned no key")

    print("\n  ✓ Kiro round-trip works: turn → resume-by-id → checkpoint. 🔥")
    print("    (cleanup: the test session's EFS/S3 can be purged via the runtime purge path)")


if __name__ == "__main__":
    main()
