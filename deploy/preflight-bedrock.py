#!/usr/bin/env python3
"""
preflight-bedrock.py — fail fast if Bedrock model access isn't enabled.

install.sh tells the user "Bedrock works out of the box", but a brand-new AWS
account has NO foundation-model access enabled by default — it's an explicit,
per-model opt-in in the Bedrock console. Without this check, the install spends
~10 minutes building images and provisioning a runtime, and only then does the
FIRST coding turn fail with an opaque AccessDenied buried in the runtime logs.

This runs in seconds during preflight: a minimal InvokeModel against the model
the runtime will use (ANTHROPIC_MODEL). It distinguishes "not enabled" (fatal,
with the console link) from benign errors (throttling, validation) that don't
indicate missing access.

Exit codes:
  0  model is invocable (or the check couldn't run definitively — non-blocking)
  1  model access is denied — a remediation link was printed

Usage:
  source deploy/config.sh
  python3 deploy/preflight-bedrock.py
"""
from __future__ import annotations

import json
import os
import sys

import boto3
from botocore.exceptions import ClientError


def main() -> int:
    region = os.environ.get("AWS_REGION", "us-east-1")
    model = (
        os.environ.get("ANTHROPIC_MODEL")
        or os.environ.get("CLAUDE_MODEL")
        or "us.anthropic.claude-opus-4-6-v1"
    )

    print(f"  Bedrock model access: checking {model} in {region} ...")
    client = boto3.client("bedrock-runtime", region_name=region)

    # Minimal Anthropic Messages request — 1 output token is enough to prove the
    # model is invocable. We only care whether access is granted, not the reply.
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}],
    })

    try:
        client.invoke_model(modelId=model, body=body)
        print("  ✓ Bedrock model access OK")
        return 0
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        msg = exc.response["Error"]["Message"]
        # AccessDenied / not-authorized → model access genuinely not enabled.
        if code in ("AccessDeniedException", "AccessDenied") or "access" in msg.lower():
            console = (f"https://{region}.console.aws.amazon.com/bedrock/home"
                       f"?region={region}#/modelaccess")
            print("", file=sys.stderr)
            print(f"  ✗ BEDROCK MODEL ACCESS NOT ENABLED for: {model}", file=sys.stderr)
            print(f"    {code}: {msg[:200]}", file=sys.stderr)
            print("", file=sys.stderr)
            print("    Ember runs coding turns on Bedrock by default, but a new", file=sys.stderr)
            print("    account must opt in to each model first. Enable it here:", file=sys.stderr)
            print(f"    {console}", file=sys.stderr)
            print("    (or set ANTHROPIC_MODEL to a model you've already enabled).", file=sys.stderr)
            return 1
        # ValidationException etc. — access works, our probe shape was off. The
        # model is reachable; don't block the install on a probe-format quirk.
        if code in ("ValidationException", "ThrottlingException", "ModelTimeoutException"):
            print(f"  ✓ Bedrock reachable (probe returned {code} — access is granted)")
            return 0
        # Unknown error — warn but don't block; the smoke test will catch a real
        # failure later with a fuller diagnosis.
        print(f"  ! Bedrock preflight inconclusive ({code}: {msg[:120]}) — continuing.",
              file=sys.stderr)
        return 0
    except Exception as exc:  # noqa: BLE001 — never block install on a probe bug
        print(f"  ! Bedrock preflight skipped ({str(exc)[:120]}) — continuing.", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
