# The OIDC provider is account-wide and shared with the other projects in this
# account, so Terraform reads it rather than owning it. bootstrap.sh creates it
# if the account does not have one yet.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]

  # GitHub issues the subject claim with the owner's and repository's numeric
  # IDs appended to their names. The IDs never change, so a repository that is
  # renamed keeps its access and an attacker who registers the freed-up name
  # does not inherit it. The name-only form is listed second because GitHub has
  # emitted it historically and the two are indistinguishable from here; both
  # are exact matches naming this repository and this branch, so accepting
  # either does not widen who can deploy. Drop the second entry if this
  # repository is ever renamed or transferred — that is the one case where the
  # older form would let a squatter on the old name assume this role.
  deploy_subs = [
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}:ref:refs/heads/${var.deploy_branch}",
    "repo:${var.github_repo}:ref:refs/heads/${var.deploy_branch}",
  ]
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # This single condition is what makes the repository safe to open-source.
    # StringEquals, not StringLike with a wildcard: the token has to say it came
    # from a push to this exact branch of this exact repository. A pull request
    # — from a fork or otherwise — carries sub "repo:.../pull/N/merge" and
    # cannot match, and GitHub withholds the id-token permission from fork
    # workflows to begin with. There are no long-lived AWS keys anywhere.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.deploy_subs
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.name_prefix}-site-deploy"
  description          = "GitHub Actions: publish site/ to S3 and invalidate CloudFront"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # `aws s3 sync` lists the destination to work out what changed and what to
  # delete.
  statement {
    sid       = "ListSiteBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }

  statement {
    sid = "WriteSiteObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }

  statement {
    sid = "InvalidateCache"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "site-publish"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
