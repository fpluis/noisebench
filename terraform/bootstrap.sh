#!/usr/bin/env bash
#
# Creates the two things terraform/ needs but cannot create for itself:
#
#   1. the S3 bucket that holds Terraform state (the chicken-and-egg one)
#   2. the account-wide GitHub OIDC provider, if no other project made it first
#
# Run it once, before the first `terraform init`. Re-running is safe: every
# step checks before it creates.
#
#   ./bootstrap.sh
#   TF_STATE_BUCKET=my-other-name ./bootstrap.sh
#
set -euo pipefail

BUCKET="${TF_STATE_BUCKET:-noisebench-tfstate}"
REGION="${TF_STATE_REGION:-us-east-1}"
OIDC_HOST="token.actions.githubusercontent.com"

account="$(aws sts get-caller-identity --query Account --output text)"
echo "account   $account"
echo "region    $REGION"
echo "state     s3://$BUCKET"
echo

# --- state bucket ------------------------------------------------------------

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "✓ state bucket already exists"
else
  echo "→ creating state bucket"
  # us-east-1 is the one region that rejects an explicit LocationConstraint.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi

# State is the record of what exists; a corrupted or truncated write should be
# recoverable, and it should never be world-readable.
echo "→ enforcing versioning, encryption, and public access block"

aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# --- GitHub OIDC provider ----------------------------------------------------

oidc_arn="arn:aws:iam::${account}:oidc-provider/${OIDC_HOST}"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$oidc_arn" >/dev/null 2>&1; then
  echo "✓ GitHub OIDC provider already exists"
else
  echo "→ creating GitHub OIDC provider"
  # IAM still requires a thumbprint on creation even though it no longer
  # validates one for this issuer.
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_HOST}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" >/dev/null
fi

echo
echo "Done. Next:"
echo "  terraform init"
echo "  terraform apply"
