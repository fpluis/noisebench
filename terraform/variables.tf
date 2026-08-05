variable "aws_region" {
  description = <<-EOT
    Region for the site bucket. CloudFront serves every request from an edge
    location, so this only decides where a cache miss goes to fetch.
  EOT
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Apex domain. A public Route53 hosted zone for it must already exist in this account."
  type        = string
  default     = "noisebench.com"
}

variable "github_repo" {
  description = "owner/name of the only repository allowed to assume the deploy role."
  type        = string
  default     = "fpluis/noisebench"
}

variable "deploy_branch" {
  description = "Only pushes to this branch can assume the deploy role."
  type        = string
  default     = "master"
}

variable "price_class" {
  description = <<-EOT
    CloudFront price class. PriceClass_100 (North America + Europe) is the
    cheapest and still serves the whole world — requests from elsewhere just
    route to a farther edge. PriceClass_All buys closer edges everywhere.
  EOT
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}
