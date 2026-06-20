#!/usr/bin/env bash
#
# setup-coding-efs.sh — provision the VPC + EFS the coding runtime mounts at
# /mnt/efs for a persistent, elastic code workspace (git checkouts + node_modules
# blow past the ~1 GB sessionStorage quota, so we need real EFS).
#
# To keep "deploy in an afternoon" true, this uses the account's DEFAULT VPC and
# its subnets — no NAT gateways, no custom networking. It creates:
#   - a security group allowing NFS (2049) within itself
#   - an EFS filesystem (encrypted, elastic)
#   - a mount target in each of two subnets
#   - an EFS access point (POSIX root /workspace, uid/gid 0)
#
# Idempotent: tags resources with Name=cloud-code-coding-efs and reuses them.
# Writes efs.config (sourced by deploy.py). Override the VPC by exporting
# CODING_VPC_ID before running.
#
# Usage:
#   source deploy/config.sh
#   ./deploy/coding-agent-runtime/setup-coding-efs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

NAME="cloud-code-coding-efs"
CONFIG_FILE="$SCRIPT_DIR/efs.config"
R=(--region "$AWS_REGION")

echo "─── Coding runtime VPC + EFS ─────────────────────────────"
echo "  Region: $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# ─── 1. VPC + two subnets (default VPC unless overridden) ─────────────────────
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
echo "  VPC: $VPC_ID"

# Two subnets in distinct AZs (EFS mount targets need one per AZ).
# Avoid `mapfile` — macOS ships bash 3.2 which lacks it.
SUBNET_LINES=$(aws ec2 describe-subnets "${R[@]}" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "Subnets[].SubnetId" --output text | tr '\t' '\n' | head -2)
SUBNET_1=$(echo "$SUBNET_LINES" | sed -n '1p')
SUBNET_2=$(echo "$SUBNET_LINES" | sed -n '2p')
if [ -z "$SUBNET_1" ] || [ -z "$SUBNET_2" ]; then
  echo "ERROR: need >=2 subnets in $VPC_ID." >&2
  exit 1
fi
echo "  Subnets: $SUBNET_1, $SUBNET_2"

# ─── 2. Security group (NFS within itself) ────────────────────────────────────
SG_ID=$(aws ec2 describe-security-groups "${R[@]}" \
  --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group "${R[@]}" \
    --group-name "$NAME" --description "Cloud Code coding runtime NFS" \
    --vpc-id "$VPC_ID" --query "GroupId" --output text)
  # Allow NFS (2049) from members of this same SG (runtime ENI ↔ mount targets).
  aws ec2 authorize-security-group-ingress "${R[@]}" \
    --group-id "$SG_ID" --protocol tcp --port 2049 --source-group "$SG_ID" >/dev/null
fi
echo "  SecurityGroup: $SG_ID"

# ─── 3. EFS filesystem (idempotent via CreationToken) ─────────────────────────
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

# ─── 4. Mount targets (one per subnet) ────────────────────────────────────────
existing_mt_subnets=$(aws efs describe-mount-targets "${R[@]}" \
  --file-system-id "$FS_ID" --query "MountTargets[].SubnetId" --output text 2>/dev/null || echo "")
for sn in "$SUBNET_1" "$SUBNET_2"; do
  if echo "$existing_mt_subnets" | grep -qw "$sn"; then
    echo "  [skip] mount target in $sn"
  else
    aws efs create-mount-target "${R[@]}" \
      --file-system-id "$FS_ID" --subnet-id "$sn" --security-groups "$SG_ID" >/dev/null
    echo "  [create] mount target in $sn"
  fi
done

# ─── 5. Access point (POSIX root /workspace) ──────────────────────────────────
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

# ─── 6. Persist efs.config (sourced by deploy.py) ─────────────────────────────
cat > "$CONFIG_FILE" <<EOF
# Generated by setup-coding-efs.sh — sourced by deploy.py. Not committed.
export CODING_VPC_ID="$VPC_ID"
export CODING_SUBNET_1="$SUBNET_1"
export CODING_SUBNET_2="$SUBNET_2"
export CODING_SECURITY_GROUP="$SG_ID"
export CODING_EFS_FILESYSTEM_ID="$FS_ID"
export CODING_EFS_ACCESS_POINT_ARN="$AP_ARN"
EOF

echo ""
echo "OK VPC + EFS ready → $CONFIG_FILE"
