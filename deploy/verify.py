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
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


def _runtime_id_from_arn(arn: str) -> str:
    """Extract the agentRuntimeId GetAgentRuntime expects (e.g.
    'ember_coding_runtime-xxxx') from a runtime ARN. The resource segment may
    carry a ':<version>' suffix — strip it so GetAgentRuntime doesn't get a
    '<id>:<version>' it won't resolve."""
    if "/" not in arn:
        return ""
    return arn.rsplit("/", 1)[-1].split(":", 1)[0]


def _load_env_file(path: str, prefix: str = "") -> None:
    """Load KEY=VALUE / `export KEY=VALUE` lines into the environment without
    overwriting anything already set."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if line.startswith(prefix):
                line = line[len(prefix):]
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _load_env_local() -> None:
    """Load the same ids install.sh wrote so a bare `python3 deploy/verify.py`
    works without `source` first. efs.config holds CODING_EFS_FILESYSTEM_ID +
    the VPC/subnet ids (it's written by setup-coding-efs.sh and only `source`d
    into deploy.py's child process, so it never reaches .env.local) — the EFS
    mount-target diagnosis needs it. Same load order deploy.py uses."""
    here = os.path.dirname(os.path.abspath(__file__))
    _load_env_file(os.path.join(here, "coding-agent-runtime", "efs.config"), prefix="export ")
    _load_env_file(os.path.abspath(os.path.join(here, "..", ".env.local")))


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

    runtime_id = _runtime_id_from_arn(runtime_arn)
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
        byo = os.environ.get("CODING_EGRESS_MODE") == "byo"
        if bad:
            print("  ✗ NO INTERNET EGRESS — the runtime's subnets have no 0.0.0.0/0", file=sys.stderr)
            print(f"    route to a NAT gateway: {', '.join(bad)}", file=sys.stderr)
            print("    AgentCore ENIs get a private IP only, so a public subnet gives", file=sys.stderr)
            print("    NO egress. The microVM can't reach ECR/Bedrock/CloudWatch and", file=sys.stderr)
            print("    fails its health check (this is your 424 + empty log group).", file=sys.stderr)
            if byo:
                print("    BYO mode: these are YOUR subnets — add a 0.0.0.0/0 route to your", file=sys.stderr)
                print("    NAT/transit-gateway/egress appliance, then re-run deploy.py. (Or", file=sys.stderr)
                print("    unset CODING_PRIVATE_SUBNET_1/2 to let install provision a NAT.)", file=sys.stderr)
                return
            # Provisioned mode: only point at setup-coding-efs.sh if THIS checkout's
            # copy actually provisions a NAT — otherwise re-running it just rebuilds
            # the same public-subnet config and the operator loops on the failure.
            here = os.path.dirname(os.path.abspath(__file__))
            efs_script = os.path.join(here, "coding-agent-runtime", "setup-coding-efs.sh")
            provisions_nat = False
            try:
                with open(efs_script) as f:
                    provisions_nat = "create-nat-gateway" in f.read()
            except OSError:
                pass
            if provisions_nat:
                print("    Fix: re-run setup-coding-efs.sh (provisions private subnets +", file=sys.stderr)
                print("    a NAT gateway), then re-run deploy.py.", file=sys.stderr)
            else:
                print("    Fix: put these subnets in private subnets with a 0.0.0.0/0 route", file=sys.stderr)
                print("    to a NAT gateway, then re-run deploy.py to repoint the runtime.", file=sys.stderr)
            return
        # 424 but the subnets DO have a NAT/egress route → in BYO mode the likely
        # cause is the egress path itself can't reach github.com/Bedrock (a proxy
        # allowlist or firewall), not missing routing. Say so rather than fall to
        # the generic "check the logs" tail.
        if byo:
            print("  ✗ HEALTH CHECK FAILED but your subnets DO have an egress route.", file=sys.stderr)
            print("    Likely your egress path can't reach the endpoints the runtime needs", file=sys.stderr)
            print("    (Bedrock, ECR, CloudWatch, and github.com for clones). Check that", file=sys.stderr)
            print("    your NAT/proxy/firewall allows them, then re-run deploy.py.", file=sys.stderr)
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
    print(f"  Runtime: {_runtime_id_from_arn(runtime_arn)}")
    print("  Sending a trivial prompt (cold start can take 1-2 min)...")

    # A cold microVM can take well past the SDK's 60s default read timeout but
    # still succeed — give it real headroom so a slow boot doesn't masquerade as
    # a failure (the runtime itself caps a turn at ~1500s).
    client = boto3.client(
        "bedrock-agentcore", region_name=region,
        config=Config(read_timeout=600, connect_timeout=10, retries={"max_attempts": 0}),
    )
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
    except (ClientError, BotoCoreError, RuntimeError, ValueError, KeyError) as exc:
        # BotoCoreError covers ReadTimeoutError — a cold microVM that out-ran the
        # read timeout, not a deploy fault. Surface it as inconclusive, not fail.
        msg = exc.response["Error"]["Message"] if isinstance(exc, ClientError) else str(exc)
        if isinstance(exc, BotoCoreError) and not isinstance(exc, ClientError):
            print("\n  INCONCLUSIVE — the turn didn't return before the timeout "
                  "(likely a cold start).", file=sys.stderr)
            print("  Retry once the microVM is warm:  python3 deploy/verify.py", file=sys.stderr)
            return 1
        print(f"\n  FAIL — the runtime did not complete a turn.", file=sys.stderr)
        _diagnose(region, runtime_arn, msg)
        return 1

    print(f"\n  ✓ Agent replied: {answer!r}")
    print("  Ember is live and answering. 🔥")
    return 0


if __name__ == "__main__":
    sys.exit(main())
