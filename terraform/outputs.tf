output "site_url" {
  description = "Where the site ends up."
  value       = "https://${var.domain_name}"
}

output "bucket_name" {
  description = "Set as the AWS_S3_BUCKET repository secret."
  value       = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  description = "Set as the AWS_CLOUDFRONT_DISTRIBUTION_ID repository secret."
  value       = aws_cloudfront_distribution.site.id
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository secret."
  value       = aws_iam_role.deploy.arn
}

output "distribution_domain_name" {
  description = "The CloudFront hostname behind the alias records, useful when debugging DNS."
  value       = aws_cloudfront_distribution.site.domain_name
}

# Copy-paste setup for the three repository secrets the deploy workflow reads.
output "gh_secret_commands" {
  description = "Run these once, with the gh CLI authenticated against the repo."
  value       = <<-EOT
    gh secret set AWS_DEPLOY_ROLE_ARN --repo ${var.github_repo} --body "${aws_iam_role.deploy.arn}"
    gh secret set AWS_S3_BUCKET --repo ${var.github_repo} --body "${aws_s3_bucket.site.bucket}"
    gh secret set AWS_CLOUDFRONT_DISTRIBUTION_ID --repo ${var.github_repo} --body "${aws_cloudfront_distribution.site.id}"
  EOT
}
