#!/usr/bin/env python3
"""
verify.py — post-install smoke test for an Ember deployment.

Runs ONE real coding turn against the deployed AgentCore runtime and, on
failure, prints the ACTUAL cause instead of leaving you with a bare 424 +
an empty log group. This is the difference between "it works" and a 30-minute
investigation: the common failure modes (no VPC egress, Bedrock model access
not enabled, EFS mount targets still creating) are all detectable here.

Exit codes:
  0  turn succeeded — Ember is live and answering
  1  turn failed    — a diagnosis was printed; fix and re-run

Everything is env/STS-derived (reads .env.local). boto3 is already a deploy
dependency (deploy.py uses it), so no new requirements.

Usage:
  source deploy/config.sh        # or just run after install.sh
  python3 deploy/verify.py
"""
from __future__ import annotations

import json
import os
import sys
import uuid

import boto3
from botocore.exceptions import ClientError


def _load_env_local() -> None:
    """Load .env.local (repo root) so a bare `python3 deploy/verify.py` has the
    same ids install.sh wrote, without needing to `source` first."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.abspath(os.path.join(here, "..", ".env.local"))
    if not os.path.exists(path):
        return
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _runtime_subnets(control, runtime_id: str) -> list[str]:
    try:
        rt = control.get_agent_runtime(agentRuntimeId=runtime_id)
        net = rt.get("networkConfiguration", {}).get("networkModeConfig", {})
        return net.get("subnets", []) or []
    except ClientError:
        return []


def _diagnose(region: str, runtime_arn: str, err: str) -> None:
    """Print the most likely root cause for a failed turn. Ordered by how often
    each one bites a fresh install."""
    print("\n  ─── Diagnosis ─────────────────────────────────────────", file=sys.stderr)
    ec2 = boto3.client("ec2", region_name=region)
    control = boto3.client("bedrock-agentcore-control", region_name=region)

    runtime_id = runtime_arn.rsplit("/", 1)[-1] if "/" in runtime_arn else ""
    health_fail = "424" in err or "health check" in err.lower()

    # 1. VPC egress — the #1 fresh-install failure. AgentCore ENIs get a PRIVATE
    #    IP only; a public subnet (IGW route, no NAT) gives them no internet, so
    #    the microVM can't reach ECR/Bedrock/CloudWatch and never turns healthy.
    if health_fail and runtime_id:
        subnets = _runtime_subnets(control, runtime_id)
        bad = []
        for sn in subnets:
            rts = ec2.describe_route_tables(
                Filters=[{"Name": "association.subnet-id", "Values": [sn]}]
            ).get("RouteTables", [])
            if not rts:  # fall back to the VPC main route table
                vpc = ec2.describe_subnets(SubnetIds=[sn])["Subnets"][0]["VpcId"]
                rts = ec2.describe_route_tables(Filters=[
                    {"Name": "vpc-id", "Values": [vpc]},
                    {"Name": "association.main", "Values": ["true"]},
                ]).get("RouteTables", [])
            has_nat = any(
                r.get("DestinationCidrBlock") == "0.0.0.0/0" and r.get("NatGatewayId")
                for rt in rts for r in rt.get("Routes", [])
            )
            if not has_nat:
                bad.append(sn)
        if bad:
            print("  ✗ NO INTERNET EGRESS — the runtime's subnets have no 0.0.0.0/0", file=sys.stderr)
            print(f"    route to a NAT gateway: {', '.join(bad)}", file=sys.stderr)
            print("    AgentCore ENIs get a private IP only, so a public subnet gives", file=sys.stderr)
            print("    NO egress. The microVM can't reach ECR/Bedrock/CloudWatch and", file=sys.stderr)
            print("    fails its health check (this is your 424 + empty log group).", file=sys.stderr)
            print("    Fix: re-run setup-coding-efs.sh (provisions private subnets +", file=sys.stderr)
            print("    a NAT gateway), then re-run deploy.py.", file=sys.stderr)
            return

    # 2. Bedrock model access — turn reaches the CLI but Bedrock refuses.
    if "accessdenied" in err.lower() or "not authorized" in err.lower() or "model" in err.lower():
        model = os.environ.get("ANTHROPIC_MODEL", "us.anthropic.claude-opus-4-6-v1")
        print("  ✗ BEDROCK MODEL ACCESS likely not enabled for:", file=sys.stderr)
        print(f"    {model}", file=sys.stderr)
        print("    Enable it in the Bedrock console → Model access:", file=sys.stderr)
        print(f"    https://{region}.console.aws.amazon.com/bedrock/home?region={region}#/modelaccess", file=sys.stderr)
        return

    # 3. EFS mount targets still creating — a CreateAgentRuntime race.
    fs_id = os.environ.get("CODING_EFS_FILESYSTEM_ID")
    if fs_id:
        try:
            efs = boto3.client("efs", region_name=region)
            states = [m["LifeCycleState"] for m in
                      efs.describe_mount_targets(FileSystemId=fs_id).get("MountTargets", [])]
            if any(s != "available" for s in states):
                print(f"  ✗ EFS mount targets not all available: {states}", file=sys.stderr)
                print("    Wait for them to reach 'available', then re-run deploy.py.", file=sys.stderr)
                return
        except ClientError:
            pass

    # 4. Fallback — surface the raw error + where to look.
    print(f"  ✗ Turn failed: {err[:300]}", file=sys.stderr)
    if runtime_id:
        print("    Check the runtime logs:", file=sys.stderr)
        print(f"    aws logs tail /aws/bedrock-agentcore/runtimes/{runtime_id}-DEFAULT "
              f"--region {region} --since 15m", file=sys.stderr)


def main() -> int:
    _load_env_local()
    region = os.environ.get("AWS_REGION", "us-east-1")
    runtime_arn = os.environ.get("CODING_AGENT_RUNTIME_ARN", "")
    if not runtime_arn:
        print("SKIP verify: CODING_AGENT_RUNTIME_ARN not set (runtime not deployed).", file=sys.stderr)
        return 0

    print("─── Smoke test: one real coding turn ─────────────────────")
    print(f"  Runtime: {runtime_arn.rsplit('/', 1)[-1]}")
    print("  Sending a trivial prompt (cold start can take 1-2 min)...")

    client = boto3.client("bedrock-agentcore", region_name=region)
    session_id = f"verify-{uuid.uuid4().hex}{uuid.uuid4().hex}"[:48]
    payload = {
        "prompt": "Reply with exactly the text: EMBER_OK and nothing else.",
        "cli": "claude",
        "session_id": session_id,
    }

    try:
        resp = client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            runtimeSessionId=session_id,
            payload=json.dumps(payload).encode(),
            contentType="application/json",
            accept="application/json",
        )
        body = resp["response"].read().decode(errors="replace")
        parsed = json.loads(body)
        if parsed.get("error"):
            raise RuntimeError(parsed["error"])
        answer = str(parsed.get("response", "")).strip()
    except (ClientError, RuntimeError, ValueError, KeyError) as exc:
        msg = exc.response["Error"]["Message"] if isinstance(exc, ClientError) else str(exc)
        print(f"\n  FAIL — the runtime did not complete a turn.", file=sys.stderr)
        _diagnose(region, runtime_arn, msg)
        return 1

    print(f"\n  ✓ Agent replied: {answer!r}")
    print("  Ember is live and answering. 🔥")
    return 0


if __name__ == "__main__":
    sys.exit(main())
