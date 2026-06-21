#!/usr/bin/env bash
#
# setup-coding-efs.sh — provision the VPC egress + EFS the coding runtime needs.
#
# The runtime mounts EFS at /mnt/efs for a persistent, elastic code workspace
# (git checkouts + node_modules blow past the ~1 GB sessionStorage quota, so we
# need real EFS). It ALSO needs outbound internet: AgentCore runs the microVM as
# an ENI in your VPC with a PRIVATE IP only — a public subnet gives it no egress,
# so it can't reach ECR/Bedrock/CloudWatch (the microVM never turns healthy and
# every turn fails the health check). The fix is the AWS-documented pattern:
# private subnets + a NAT gateway. See:
#   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/  (VPC config)
#   "Using a public subnet does not provide internet connectivity ... place it in
#    private subnets with a route to a NAT Gateway."
#
# This script, in the account's DEFAULT VPC (override with CODING_VPC_ID):
#   - reuses/creates 2 PRIVATE subnets in distinct supported AZs
#   - reuses/creates a NAT gateway (in a public subnet) + its route table
#     (0.0.0.0/0 → NAT) and associates the private subnets
#   - a security group allowing NFS (2049) within itself
#   - an EFS filesystem (encrypted, elastic) + a mount target per private-subnet AZ
#   - an EFS access point (POSIX root /workspace, uid/gid 0)
#
# Idempotent: tags resources with Name=ember-coding-* and reuses them.
# Writes efs.config (sourced by deploy.py).
#
# Overrides (export before running):
#   CODING_VPC_ID              use a specific VPC instead of the default
#   CODING_PRIVATE_SUBNET_1/2  use pre-made private subnets (skip auto-carve)
#   CODING_NAT_SUBNET          public subnet to place the NAT in
#   CODING_PRIVATE_PREFIX      new-subnet prefix length to carve (default 20)
#
# Usage:
#   source deploy/config.sh
#   ./deploy/coding-agent-runtime/setup-coding-efs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

NAME="ember-coding-efs"
NAT_NAME="ember-coding-nat"
PRIV_RT_NAME="ember-coding-private-rt"
PRIV_SUBNET_PREFIX="ember-coding-private"
CONFIG_FILE="$SCRIPT_DIR/efs.config"
PRIVATE_PREFIX="${CODING_PRIVATE_PREFIX:-20}"
R=(--region "$AWS_REGION")

echo "─── Coding runtime VPC + NAT egress + EFS ────────────────"
echo "  Region: $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

_tag() { aws ec2 create-tags "${R[@]}" --resources "$1" --tags "Key=Name,Value=$2" >/dev/null; }
_az_of() { aws ec2 describe-subnets "${R[@]}" --subnet-ids "$1" --query "Subnets[0].AvailabilityZone" --output text; }

# ─── 1. VPC (default unless overridden) ───────────────────────────────────────
VPC_ID="${CODING_VPC_ID:-}"
if [ -z "$VPC_ID" ]; then
  VPC_ID=$(aws ec2 describe-vpcs "${R[@]}" \
    --filters "Name=isDefault,Values=true" \
    --query "Vpcs[0].VpcId" --output text)
fi
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "ERROR: no default VPC found. Export CODING_VPC_ID=<vpc-id> and retry." >&2
  exit 1
fi
VPC_CIDR=$(aws ec2 describe-vpcs "${R[@]}" --vpc-ids "$VPC_ID" \
  --query "Vpcs[0].CidrBlock" --output text)
echo "  VPC: $VPC_ID ($VPC_CIDR)"

# ─── 2. A public subnet to host the NAT gateway ───────────────────────────────
# NAT must live in a subnet that ROUTES to an internet gateway. The real
# definition of "public" is an IGW route in the associated route table — NOT
# MapPublicIpOnLaunch (that's just instance auto-addressing, and a hardened VPC
# can have it off on a genuinely public subnet, or on with no IGW route). So we
# test each subnet's effective route table (its explicit association, else the
# VPC main table) for a 0.0.0.0/0 → igw-* route.
_subnet_has_igw() {
  local sn="$1"
  # A subnet's EFFECTIVE route table is its explicit association if it has one,
  # otherwise the VPC main table. Resolve that single table first — never OR the
  # two together, or a private subnet explicitly bound to a private table would
  # be wrongly accepted just because the VPC main table happens to be public.
  local explicit
  explicit=$(aws ec2 describe-route-tables "${R[@]}" \
    --filters "Name=association.subnet-id,Values=$sn" \
    --query "RouteTables[0].RouteTableId" --output text 2>/dev/null || echo "")
  local rts
  if [ -n "$explicit" ] && [ "$explicit" != "None" ]; then
    rts=$(aws ec2 describe-route-tables "${R[@]}" --route-table-ids "$explicit" \
      --query "RouteTables[0].Routes[?starts_with(GatewayId,'igw-')].GatewayId" \
      --output text 2>/dev/null || echo "")
  else
    # No explicit association → the subnet uses the VPC main route table.
    rts=$(aws ec2 describe-route-tables "${R[@]}" \
      --filters "Name=vpc-id,Values=$VPC_ID" "Name=association.main,Values=true" \
      --query "RouteTables[0].Routes[?starts_with(GatewayId,'igw-')].GatewayId" \
      --output text 2>/dev/null || echo "")
  fi
  [ -n "$rts" ]
}

NAT_SUBNET="${CODING_NAT_SUBNET:-}"
if [ -n "$NAT_SUBNET" ]; then
  _subnet_has_igw "$NAT_SUBNET" || {
    echo "ERROR: CODING_NAT_SUBNET=$NAT_SUBNET has no internet-gateway route." >&2
    echo "       A NAT gateway needs a public subnet (route table with 0.0.0.0/0 → igw-*)." >&2
    exit 1
  }
else
  for sn in $(aws ec2 describe-subnets "${R[@]}" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query "Subnets[].SubnetId" --output text | tr '\t' '\n'); do
    if _subnet_has_igw "$sn"; then NAT_SUBNET="$sn"; break; fi
  done
fi
if [ -z "$NAT_SUBNET" ] || [ "$NAT_SUBNET" = "None" ]; then
  echo "ERROR: no public subnet (with an internet-gateway route) found in $VPC_ID." >&2
  echo "       Export CODING_NAT_SUBNET=<public-subnet-id> and retry." >&2
  exit 1
fi
echo "  NAT public subnet: $NAT_SUBNET"

# ─── 3. Two PRIVATE subnets in distinct AZs ───────────────────────────────────
# Reuse any we previously tagged; otherwise carve free CIDRs out of the VPC and
# create them in two distinct AZs (EFS mount targets are per-AZ; two AZs = HA).
PRIV_1="${CODING_PRIVATE_SUBNET_1:-}"
PRIV_2="${CODING_PRIVATE_SUBNET_2:-}"
if [ -z "$PRIV_1" ] || [ -z "$PRIV_2" ]; then
  existing=$(aws ec2 describe-subnets "${R[@]}" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Name,Values=${PRIV_SUBNET_PREFIX}-*" \
    --query "Subnets[].SubnetId" --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')
  PRIV_1=$(echo "$existing" | sed -n '1p')
  PRIV_2=$(echo "$existing" | sed -n '2p')
fi

if [ -n "$PRIV_1" ] && [ -n "$PRIV_2" ]; then
  echo "  Private subnets (reused): $PRIV_1, $PRIV_2"
else
  # Pick two distinct AZs (prefer the AZs the default subnets already live in, so
  # EFS mount targets are local). Then carve two free CIDRs of /$PRIVATE_PREFIX.
  AZ_LINES=$(aws ec2 describe-subnets "${R[@]}" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "Subnets[].AvailabilityZone" --output text | tr '\t' '\n' | sort -u | head -2)
  AZ_1=$(echo "$AZ_LINES" | sed -n '1p')
  AZ_2=$(echo "$AZ_LINES" | sed -n '2p')
  if [ -z "$AZ_1" ] || [ -z "$AZ_2" ]; then
    echo "ERROR: need >=2 AZs in $VPC_ID to place private subnets." >&2
    exit 1
  fi

  USED_CIDRS=$(aws ec2 describe-subnets "${R[@]}" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "Subnets[].CidrBlock" --output text | tr '\t' ' ')
  # Robust CIDR math via python3 (a deploy.py dependency already): emit the first
  # two /$PRIVATE_PREFIX blocks inside the VPC that don't overlap anything in use.
  FREE_CIDRS=$(python3 - "$VPC_CIDR" "$PRIVATE_PREFIX" "$USED_CIDRS" <<'PY'
import ipaddress, sys
vpc = ipaddress.ip_network(sys.argv[1])
new_prefix = int(sys.argv[2])
used = [ipaddress.ip_network(c) for c in sys.argv[3].split() if c]
out = []
if new_prefix >= vpc.prefixlen:
    for cand in vpc.subnets(new_prefix=new_prefix):
        if not any(cand.overlaps(u) for u in used):
            out.append(str(cand))
        if len(out) == 2:
            break
print(" ".join(out))
PY
)
  CIDR_1=$(echo "$FREE_CIDRS" | awk '{print $1}')
  CIDR_2=$(echo "$FREE_CIDRS" | awk '{print $2}')
  if [ -z "$CIDR_1" ] || [ -z "$CIDR_2" ]; then
    echo "ERROR: no free /$PRIVATE_PREFIX blocks in $VPC_CIDR. Set CODING_PRIVATE_SUBNET_1/2." >&2
    exit 1
  fi
  PRIV_1=$(aws ec2 create-subnet "${R[@]}" --vpc-id "$VPC_ID" \
    --cidr-block "$CIDR_1" --availability-zone "$AZ_1" \
    --query "Subnet.SubnetId" --output text)
  _tag "$PRIV_1" "${PRIV_SUBNET_PREFIX}-1"
  PRIV_2=$(aws ec2 create-subnet "${R[@]}" --vpc-id "$VPC_ID" \
    --cidr-block "$CIDR_2" --availability-zone "$AZ_2" \
    --query "Subnet.SubnetId" --output text)
  _tag "$PRIV_2" "${PRIV_SUBNET_PREFIX}-2"
  echo "  Private subnets (created): $PRIV_1 ($AZ_1 $CIDR_1), $PRIV_2 ($AZ_2 $CIDR_2)"
fi

# ─── 4. NAT gateway (+ Elastic IP), reused by tag ─────────────────────────────
NAT_ID=$(aws ec2 describe-nat-gateways "${R[@]}" \
  --filter "Name=vpc-id,Values=$VPC_ID" "Name=tag:Name,Values=$NAT_NAME" \
           "Name=state,Values=available,pending" \
  --query "NatGateways[0].NatGatewayId" --output text 2>/dev/null || echo "None")
if [ "$NAT_ID" = "None" ] || [ -z "$NAT_ID" ]; then
  EIP_ALLOC=$(aws ec2 describe-addresses "${R[@]}" \
    --filters "Name=tag:Name,Values=$NAT_NAME" \
    --query "Addresses[0].AllocationId" --output text 2>/dev/null || echo "None")
  if [ "$EIP_ALLOC" = "None" ] || [ -z "$EIP_ALLOC" ]; then
    EIP_ALLOC=$(aws ec2 allocate-address "${R[@]}" --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAT_NAME}]" \
      --query "AllocationId" --output text)
  fi
  NAT_ID=$(aws ec2 create-nat-gateway "${R[@]}" \
    --subnet-id "$NAT_SUBNET" --allocation-id "$EIP_ALLOC" \
    --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=$NAT_NAME}]" \
    --query "NatGateway.NatGatewayId" --output text)
  echo "  [create] NAT $NAT_ID"
fi
# Always wait for 'available' — we reuse NAT gateways in 'pending' too (a rerun
# after an interrupted/concurrent deploy), so the create-only waiter would let
# install.sh deploy AgentCore against a not-yet-ready NAT and hit the same
# no-egress failure. The waiter is a no-op on an already-available NAT.
echo "  NAT: $NAT_ID — waiting for available..."
aws ec2 wait nat-gateway-available "${R[@]}" --nat-gateway-ids "$NAT_ID"

# ─── 5. Private route table (0.0.0.0/0 → NAT) + associations ───────────────────
PRIV_RT=$(aws ec2 describe-route-tables "${R[@]}" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Name,Values=$PRIV_RT_NAME" \
  --query "RouteTables[0].RouteTableId" --output text 2>/dev/null || echo "None")
if [ "$PRIV_RT" = "None" ] || [ -z "$PRIV_RT" ]; then
  PRIV_RT=$(aws ec2 create-route-table "${R[@]}" --vpc-id "$VPC_ID" \
    --query "RouteTable.RouteTableId" --output text)
  _tag "$PRIV_RT" "$PRIV_RT_NAME"
fi
# Route to NAT (create, or replace if it already points elsewhere).
if aws ec2 create-route "${R[@]}" --route-table-id "$PRIV_RT" \
     --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_ID" >/dev/null 2>&1; then :; else
  aws ec2 replace-route "${R[@]}" --route-table-id "$PRIV_RT" \
    --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_ID" >/dev/null 2>&1 || true
fi
# Associate both private subnets with PRIV_RT. A subnet already has an
# association (explicit, or implicitly the main table): associate-route-table
# fails on an already-explicitly-associated subnet, so when a user-supplied
# CODING_PRIVATE_SUBNET_* is already attached elsewhere we must REPLACE its
# association. Skip only if it's already on PRIV_RT.
already_on_priv=$(aws ec2 describe-route-tables "${R[@]}" --route-table-ids "$PRIV_RT" \
  --query "RouteTables[0].Associations[].SubnetId" --output text 2>/dev/null || echo "")
for sn in "$PRIV_1" "$PRIV_2"; do
  if echo "$already_on_priv" | grep -qw "$sn"; then
    echo "  [skip] route assoc $sn"
    continue
  fi
  # Existing EXPLICIT association for this subnet (on some other table)?
  existing_assoc=$(aws ec2 describe-route-tables "${R[@]}" \
    --filters "Name=association.subnet-id,Values=$sn" \
    --query "RouteTables[].Associations[?SubnetId=='$sn'].RouteTableAssociationId | [0]" \
    --output text 2>/dev/null || echo "")
  if [ -n "$existing_assoc" ] && [ "$existing_assoc" != "None" ]; then
    aws ec2 replace-route-table-association "${R[@]}" \
      --association-id "$existing_assoc" --route-table-id "$PRIV_RT" >/dev/null
    echo "  [reassoc] $sn → $PRIV_RT (was $existing_assoc)"
  else
    aws ec2 associate-route-table "${R[@]}" --route-table-id "$PRIV_RT" --subnet-id "$sn" >/dev/null
    echo "  [assoc] $sn → $PRIV_RT"
  fi
done
echo "  Private route table: $PRIV_RT (0.0.0.0/0 → $NAT_ID)"

# ─── 6. Security group (NFS within itself) ────────────────────────────────────
SG_ID=$(aws ec2 describe-security-groups "${R[@]}" \
  --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group "${R[@]}" \
    --group-name "$NAME" --description "Ember coding runtime NFS" \
    --vpc-id "$VPC_ID" --query "GroupId" --output text)
  # Allow NFS (2049) from members of this same SG (runtime ENI ↔ mount targets).
  aws ec2 authorize-security-group-ingress "${R[@]}" \
    --group-id "$SG_ID" --protocol tcp --port 2049 --source-group "$SG_ID" >/dev/null
fi
echo "  SecurityGroup: $SG_ID"

# ─── 7. EFS filesystem (idempotent via CreationToken) ─────────────────────────
FS_ID=$(aws efs describe-file-systems "${R[@]}" \
  --query "FileSystems[?Name=='$NAME'].FileSystemId | [0]" --output text 2>/dev/null || echo "None")
if [ "$FS_ID" = "None" ] || [ -z "$FS_ID" ]; then
  FS_ID=$(aws efs create-file-system "${R[@]}" \
    --creation-token "$NAME" --encrypted \
    --performance-mode generalPurpose --throughput-mode elastic \
    --tags "Key=Name,Value=$NAME" \
    --query "FileSystemId" --output text)
  echo "  [create] EFS $FS_ID — waiting for available..."
  for _ in $(seq 1 60); do
    st=$(aws efs describe-file-systems "${R[@]}" --file-system-id "$FS_ID" \
      --query "FileSystems[0].LifeCycleState" --output text)
    [ "$st" = "available" ] && break
    sleep 5
  done
fi
echo "  EFS: $FS_ID"

# ─── 8. Mount targets — one per AZ of the private subnets ─────────────────────
# Mount targets are per-AZ; create in the private subnets, skipping any AZ that
# already has a mount target for this filesystem (CreateMountTarget errors on a
# duplicate AZ). Then wait for them to leave 'creating' — AgentCore CreateAgent
# rejects mount targets still in the creating state.
existing_mt=$(aws efs describe-mount-targets "${R[@]}" \
  --file-system-id "$FS_ID" --query "MountTargets[].SubnetId" --output text 2>/dev/null || echo "")
existing_azs=""
for mt_sn in $existing_mt; do
  existing_azs="$existing_azs $(_az_of "$mt_sn")"
done
for sn in "$PRIV_1" "$PRIV_2"; do
  az=$(_az_of "$sn")
  if echo "$existing_azs" | grep -qw "$az"; then
    echo "  [skip] mount target in $az"
  else
    aws efs create-mount-target "${R[@]}" \
      --file-system-id "$FS_ID" --subnet-id "$sn" --security-groups "$SG_ID" >/dev/null
    existing_azs="$existing_azs $az"
    echo "  [create] mount target in $az ($sn)"
  fi
done
echo "  waiting for mount targets to become available..."
for _ in $(seq 1 60); do
  states=$(aws efs describe-mount-targets "${R[@]}" --file-system-id "$FS_ID" \
    --query "MountTargets[].LifeCycleState" --output text 2>/dev/null || echo "")
  echo "$states" | grep -qw creating || break
  sleep 5
done

# ─── 9. Access point (POSIX root /workspace) ──────────────────────────────────
AP_ARN=$(aws efs describe-access-points "${R[@]}" \
  --file-system-id "$FS_ID" \
  --query "AccessPoints[?Tags[?Key=='Name' && Value=='$NAME']].AccessPointArn | [0]" \
  --output text 2>/dev/null || echo "None")
if [ "$AP_ARN" = "None" ] || [ -z "$AP_ARN" ]; then
  AP_ARN=$(aws efs create-access-point "${R[@]}" \
    --file-system-id "$FS_ID" \
    --tags "Key=Name,Value=$NAME" \
    --posix-user "Uid=0,Gid=0" \
    --root-directory '{"Path":"/workspace","CreationInfo":{"OwnerUid":0,"OwnerGid":0,"Permissions":"0755"}}' \
    --query "AccessPointArn" --output text)
fi
echo "  AccessPoint: $AP_ARN"

# ─── 10. Persist efs.config (sourced by deploy.py) ────────────────────────────
# CODING_SUBNET_1/2 are the PRIVATE subnets (NAT egress) — this is what the
# runtime's networkConfiguration must use so its private-IP ENI can reach
# ECR/Bedrock/CloudWatch.
cat > "$CONFIG_FILE" <<EOF
# Generated by setup-coding-efs.sh — sourced by deploy.py. Not committed.
export CODING_VPC_ID="$VPC_ID"
export CODING_SUBNET_1="$PRIV_1"
export CODING_SUBNET_2="$PRIV_2"
export CODING_SECURITY_GROUP="$SG_ID"
export CODING_EFS_FILESYSTEM_ID="$FS_ID"
export CODING_EFS_ACCESS_POINT_ARN="$AP_ARN"
export CODING_NAT_GATEWAY_ID="$NAT_ID"
export CODING_PRIVATE_ROUTE_TABLE="$PRIV_RT"
EOF

echo ""
echo "OK VPC + NAT + EFS ready → $CONFIG_FILE"
