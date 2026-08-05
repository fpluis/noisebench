terraform {
  required_version = ">= 1.11"

  # The state bucket and the account-wide GitHub OIDC provider are the two
  # things this config cannot create for itself. bootstrap.sh makes both, and
  # has to run once before the first `terraform init`.
  backend "s3" {
    bucket = "noisebench-tfstate"
    key    = "site/terraform.tfstate"
    region = "us-east-1"

    # Locking through a lock file in the same bucket. Terraform 1.11+ only;
    # no DynamoDB table to pay for or forget about.
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# A certificate attached to CloudFront has to live in us-east-1 regardless of
# where the bucket is, so ACM gets its own provider.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
